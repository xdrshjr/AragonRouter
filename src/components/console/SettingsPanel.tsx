'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Info, KeyRound, Lock, Server, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardTitle } from '@/components/ui/Card';
import { ErrorState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Switch } from '@/components/ui/Switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/components/auth/auth-context';
import { useAdminQuery } from '@/components/console/use-admin-query';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import {
  ADMIN_API_BASE,
  SESSION_COOKIE_NAME,
  describeApiFailure,
  getSettings,
  isUnauthorized,
  listKeys,
  listProviders,
  updateSettings,
} from '@/components/console/api';
import type { ApiKeyPublic, ProviderPublic, RegistrationSetting } from '@/components/console/types';

/** Session lifetime documented by C3 (seven days). */
const SESSION_TTL_DAYS = 7;

export interface DeploymentSummaryLoaders {
  loadKeys: (signal: AbortSignal) => Promise<ApiKeyPublic[]>;
  loadProviders: (signal: AbortSignal) => Promise<ProviderPublic[]>;
}

/**
 * The two read-only summary requests of this page, switched off for a `member`.
 *
 * `/api/admin/keys` and `/api/admin/providers` answer 403 to a non-administrator, so a
 * member who somehow rendered this panel would see nothing but the spurious
 * "Configuration summary is unavailable" block at the top of an otherwise informative
 * page. Returning an empty summary instead keeps the page honest - it says nothing
 * about a deployment it is not allowed to read - and guarantees this panel never fires
 * an administrator request on behalf of somebody who cannot use it.
 *
 * @param canManageAccounts - the `isAdmin` flag of the auth context
 */
export function summarizeDeployment(canManageAccounts: boolean): DeploymentSummaryLoaders {
  if (canManageAccounts) {
    return {
      loadKeys: (signal) => listKeys(signal),
      loadProviders: (signal) => listProviders(signal),
    };
  }
  return {
    loadKeys: () => Promise.resolve([]),
    loadProviders: () => Promise.resolve([]),
  };
}


interface EnvRow {
  name: string;
  required: boolean;
  description: string;
  /** Never a real value: this page must not leak configuration secrets. */
  display: string;
}

/** C1 environment contract, shown as a reference - names and rules only. */
const ENV_ROWS: readonly EnvRow[] = [
  {
    name: 'ADMIN_PASSWORD',
    required: true,
    description: 'Password accepted by POST /api/admin/session. Minimum 8 characters.',
    display: 'hidden',
  },
  {
    name: 'SESSION_SECRET',
    required: true,
    description: 'HMAC-SHA256 key that signs the session cookie. At least 32 characters.',
    display: 'hidden',
  },
  {
    name: 'ENCRYPTION_KEY',
    required: true,
    description: 'AES-256-GCM key sealing upstream credentials at rest. Exactly 64 hex characters.',
    display: 'hidden',
  },
  {
    name: 'DATABASE_PATH',
    required: false,
    description: 'SQLite file used by the data layer.',
    display: './data/aragon.db (default)',
  },
];

const CLIENT_ENDPOINTS: readonly { method: string; path: string; description: string }[] = [
  { method: 'POST', path: '/api/v1/messages', description: 'Anthropic messages protocol, including stream:true SSE.' },
  { method: 'POST', path: '/api/v1/chat/completions', description: 'OpenAI-compatible chat completions.' },
  { method: 'GET', path: '/api/v1/models', description: 'Models reported by the enabled upstreams.' },
];

const ADMIN_ENDPOINTS: readonly { method: string; path: string; description: string }[] = [
  { method: 'POST', path: '/api/admin/session', description: 'Sign in; sets the HttpOnly session cookie.' },
  { method: 'DELETE', path: '/api/admin/session', description: 'Sign out; clears the cookie.' },
  { method: 'GET', path: '/api/admin/keys', description: 'List issued keys (prefixes only).' },
  { method: 'POST', path: '/api/admin/keys', description: 'Create a key; the plaintext is returned once.' },
  { method: 'DELETE', path: '/api/admin/keys/[id]', description: 'Soft-revoke a key.' },
  { method: 'GET', path: '/api/admin/providers', description: 'List upstreams with masked credentials.' },
  { method: 'POST', path: '/api/admin/providers', description: 'Add an upstream; the key is encrypted.' },
  { method: 'PATCH', path: '/api/admin/providers/[id]', description: 'Update an upstream; omit apiKey to keep it.' },
  { method: 'DELETE', path: '/api/admin/providers/[id]', description: 'Delete an upstream.' },
  { method: 'POST', path: '/api/admin/providers/[id]/test', description: 'Probe {baseUrl}/v1/models with a 5s budget.' },
  { method: 'GET', path: '/api/admin/logs', description: 'Cursor-paginated request log.' },
  { method: 'GET', path: '/api/admin/stats', description: 'Usage aggregates for 24h / 7d / 30d.' },
  {
    method: 'GET',
    path: '/api/admin/users',
    description: 'Keyset-paginated accounts (search / role / status).',
  },
  { method: 'GET', path: '/api/admin/settings', description: 'Read the registration switch.' },
  { method: 'PATCH', path: '/api/admin/settings', description: 'Write the registration switch.' },
];

/**
 * `/console/settings` - the deployment's configuration surface.
 *
 * Almost everything here is read-only by design: the gateway is configured through
 * environment variables and the console must never be able to read or change them.
 * What this page shows is therefore (a) the values it can derive from the published
 * contracts - key and provider counts - and (b) the *contract* of the configuration
 * (variable names, endpoint list, cookie properties), never a secret value.
 *
 * The single exception is the registration switch (C-SETTINGS-WIRE): it is a product
 * setting, not a deployment secret, so an administrator may flip it here. A `member`
 * sees the same value read-only - the write is administrator-only on the server too.
 */
export function SettingsPanel(): ReactNode {
  const auth = useAuth();
  const toast = useToast();
  /**
   * Defence in depth, not the primary gate: `AuthGuard`'s body replaces this page with
   * the "administrator access required" mask for a non-admin, so a `member` cannot
   * reach the read-only branch through the shell today. It is kept for two reasons:
   * mounting this panel elsewhere must never fire an administrator request on behalf
   * of somebody who cannot use it (`summarizeDeployment` returns an empty summary
   * instead), and the registration switch must degrade to an honest read-only value
   * rather than a control that answers 403.
   */
  const canManageAccounts = auth.isAdmin;
  const summaryLoaders = useMemo(
    () => summarizeDeployment(canManageAccounts),
    [canManageAccounts],
  );
  const keys = useAdminQuery(summaryLoaders.loadKeys, [summaryLoaders]);
  const providers = useAdminQuery(summaryLoaders.loadProviders, [summaryLoaders]);
  // A member is refused by `/api/admin/settings` (403), so the request is skipped and
  // the value the session probe already delivered (C-AUTH-WIRE) is displayed instead.
  const settings = useAdminQuery<RegistrationSetting | null>(
    (signal) => (canManageAccounts ? getSettings(signal) : Promise.resolve(null)),
    [canManageAccounts],
  );
  const [pendingRegistration, setPendingRegistration] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  /** What the server last confirmed, so the switch never shows an optimistic lie. */
  const [confirmedRegistration, setConfirmedRegistration] = useState<boolean | null>(null);

  useSessionExpiryRedirect(keys.error ?? providers.error ?? settings.error);

  const reload = useCallback(() => {
    keys.refresh();
    providers.refresh();
    settings.refresh();
    // Drop the value a previous toggle confirmed: a manual refresh has to show what
    // the server says now, otherwise the switch would keep rendering a stale answer.
    setConfirmedRegistration(null);
  }, [keys, providers, settings]);

  const registrationEnabled =
    confirmedRegistration ?? settings.data?.enabled ?? auth.registrationEnabled;

  const toggleRegistration = useCallback(
    async (next: boolean) => {
      setPendingRegistration(true);
      setRegistrationError(null);
      try {
        const saved = await updateSettings({ enabled: next });
        // Read it back: the switch has to show what the server stored, not what we
        // asked for. `/api/auth/register` reads the same accessor on every request.
        const confirmed = await getSettings();
        setConfirmedRegistration(confirmed.enabled);
        if (confirmed.enabled !== saved.enabled) {
          setRegistrationError(
            'The server stored a different value than requested. Reload the page to see the truth.',
          );
        } else {
          toast.push({
            title: confirmed.enabled ? 'Registration opened' : 'Registration closed',
            description: confirmed.enabled
              ? 'New visitors can create a member account from the sign-in dialog.'
              : 'The register tab is hidden and POST /api/auth/register answers 403.',
            tone: confirmed.enabled ? 'success' : 'warning',
          });
        }
        // The shell reads `registration.enabled` from /api/auth/session; refreshing the
        // context keeps the sign-in dialog's register tab in step with the switch.
        await auth.refresh();
      } catch (error) {
        setRegistrationError(describeApiFailure(error));
      } finally {
        setPendingRegistration(false);
      }
    },
    [auth, toast],
  );

  const keyRows = keys.data ?? [];
  const providerRows = providers.data ?? [];
  const activeKeys = keyRows.filter((row) => row.revokedAt === null).length;
  const enabledProviders = providerRows.filter((row) => row.enabled).length;
  const loading = keys.loading || providers.loading;
  const failure = keys.error ?? providers.error;
  /**
   * A failed *settings read* is reported next to the switch it governs.
   *
   * Without this the switch would render the value the session probe delivered
   * (C-AUTH-WIRE) while `GET /api/admin/settings` may have answered 500: the operator
   * would see a plausible value that was never read from the endpoint that owns it.
   * A 401 is excluded because the shell already answers it with the sign-in dialog.
   */
  const registrationReadFailure =
    settings.error !== null && !isUnauthorized(settings.error)
      ? describeApiFailure(settings.error)
      : null;
  const registrationMessage = registrationError ?? registrationReadFailure;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-caps">Settings</p>
          <h2 className="mt-1 text-xl font-semibold leading-7 text-text">Configuration</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Read-only for the deployment: the gateway is configured through the environment and this
            console never displays or edits secrets. The registration switch below is the only
            setting it can change.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={reload} loading={loading} loadingLabel="Refreshing">
          Refresh
        </Button>
      </div>

      {failure && !isUnauthorized(failure) ? (
        <ErrorState
          title="Configuration summary is unavailable"
          message={failure.message}
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      ) : null}

      <Card>
        <CardTitle
          eyebrow="Accounts"
          description={
            'Controls whether the sign-in dialog offers the register tab and whether ' +
            'POST /api/auth/register accepts new accounts.'
          }
        >
          <span className="inline-flex items-center gap-1.5">
            <UserPlus size={14} aria-hidden="true" className="text-brand" />
            Registration
          </span>
        </CardTitle>
        <div className="mt-3 space-y-2">
          <div
            className={
              'flex flex-wrap items-center justify-between gap-3 rounded-md border ' +
              'border-border bg-surface-2 px-3 py-2'
            }
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">Allow self-registration</p>
              <p className="mt-0.5 text-xs leading-5 text-muted">
                {registrationEnabled
                  ? 'New visitors may create a member account. Administrators can still ' +
                    'create and disable accounts.'
                  : 'Sign-ups are closed: only an administrator can create an account.'}
              </p>
            </div>
            {canManageAccounts ? (
              <Switch
                checked={registrationEnabled}
                onCheckedChange={(next) => {
                  void toggleRegistration(next);
                }}
                label="Allow self-registration"
                description="Allow registration"
                pending={pendingRegistration || settings.loading}
                disabled={pendingRegistration}
              />
            ) : (
              <Badge tone="neutral">
                {registrationEnabled ? 'read-only: open' : 'read-only: closed'}
              </Badge>
            )}
          </div>
          {registrationMessage ? (
            <p role="alert" className="text-xs leading-5 text-danger">
              {registrationMessage}
            </p>
          ) : null}
          <p className="text-[11px] leading-4 text-muted">
            {canManageAccounts
              ? 'The change is written immediately and read back from the server before ' +
                'this page reports success.'
              : 'Only an administrator can change this switch; this view shows the state ' +
                'the server reported.'}
          </p>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle eyebrow="Deployment" description="Derived from the admin API, not from a config endpoint.">
            Current state
          </CardTitle>
          {!canManageAccounts ? (
            // Never "0 / 0" and never a spinner: a summary a member may not read must
            // not look like an empty deployment, and nothing is being requested.
            <p className="mt-3 text-xs leading-5 text-muted">
              Key and provider counts need an administrator session, so nothing is requested
              and no number is shown.
            </p>
          ) : loading ? (
            <LoadingBlock label="Loading summary" />
          ) : (
            <dl className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
                <dt className="label-caps">Active keys</dt>
                <dd className="tabular mt-1 text-lg font-semibold text-text">
                  {activeKeys}
                  <span className="ml-1 text-xs font-normal text-muted">/ {keyRows.length}</span>
                </dd>
              </div>
              <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
                <dt className="label-caps">Enabled providers</dt>
                <dd className="tabular mt-1 text-lg font-semibold text-text">
                  {enabledProviders}
                  <span className="ml-1 text-xs font-normal text-muted">
                    / {providerRows.length}
                  </span>
                </dd>
              </div>
            </dl>
          )}
        </Card>

        <Card>
          <CardTitle eyebrow="Session" description="How the admin cookie behaves.">
            Session
          </CardTitle>
          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Cookie</dt>
              <dd className="mono text-text">{SESSION_COOKIE_NAME}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Flags</dt>
              <dd className="flex flex-wrap items-center gap-1">
                <Badge tone="neutral">HttpOnly</Badge>
                <Badge tone="neutral">SameSite=Lax</Badge>
                <Badge tone="neutral">Path=/</Badge>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Lifetime</dt>
              <dd className="text-text">{SESSION_TTL_DAYS} days, signed with HMAC-SHA256</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Signing key</dt>
              <dd className="text-muted">
                <span className="inline-flex items-center gap-1">
                  <Lock size={11} aria-hidden="true" /> SESSION_SECRET (hidden)
                </span>
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card flush className="overflow-hidden">
        <div className="border-b border-border p-4">
          <CardTitle
            eyebrow="Environment"
            description="Values are read at request time on the server and never sent to this page."
          >
            Environment variables
          </CardTitle>
        </div>
        <Table minWidth={640} caption="Environment variables">
          <TableHeader>
            <TableRow>
              <TableHead>Variable</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Value seen here</TableHead>
              <TableHead>Rule</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ENV_ROWS.map((row) => (
              <TableRow key={row.name}>
                <TableCell>
                  <span className="mono text-xs text-text">{row.name}</span>
                </TableCell>
                <TableCell>
                  {row.required ? <Badge tone="brand">required</Badge> : <Badge tone="neutral">optional</Badge>}
                </TableCell>
                <TableCell>
                  <span className="mono text-xs text-muted">{row.display}</span>
                </TableCell>
                <TableCell className="text-xs text-muted">{row.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card flush className="overflow-hidden">
          <div className="border-b border-border p-4">
            <CardTitle eyebrow="Client API" description="Called with an ar-… key from your application.">
              <span className="inline-flex items-center gap-1.5">
                <KeyRound size={14} aria-hidden="true" className="text-brand" />
                Relay endpoints
              </span>
            </CardTitle>
          </div>
          <Table minWidth={520} caption="Client relay endpoints">
            <TableHeader>
              <TableRow>
                <TableHead>Method</TableHead>
                <TableHead>Path</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CLIENT_ENDPOINTS.map((endpoint) => (
                <TableRow key={endpoint.path}>
                  <TableCell>
                    <Badge tone="info">{endpoint.method}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className="mono text-xs text-text">{endpoint.path}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted">{endpoint.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card flush className="overflow-hidden">
          <div className="border-b border-border p-4">
            <CardTitle eyebrow="Admin API" description={`Every route requires the ${SESSION_COOKIE_NAME} cookie.`}>
              <span className="inline-flex items-center gap-1.5">
                <Server size={14} aria-hidden="true" className="text-info" />
                Console endpoints
              </span>
            </CardTitle>
          </div>
          <Table minWidth={560} caption="Admin endpoints">
            <TableHeader>
              <TableRow>
                <TableHead>Method</TableHead>
                <TableHead>Path</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ADMIN_ENDPOINTS.map((endpoint) => (
                <TableRow key={`${endpoint.method} ${endpoint.path}`}>
                  <TableCell>
                    <Badge tone={endpoint.method === 'GET' ? 'neutral' : 'warning'}>{endpoint.method}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className="mono text-xs text-text">{endpoint.path}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted">{endpoint.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card>
        <CardTitle eyebrow="Data handling">Security notes</CardTitle>
        <ul className="mt-3 space-y-1.5 text-xs leading-5 text-muted">
          <li className="flex gap-2">
            <Info size={12} aria-hidden="true" className="mt-1 shrink-0 text-info" />
            Upstream credentials are encrypted with AES-256-GCM and only ever leave the server as a
            masked preview.
          </li>
          <li className="flex gap-2">
            <Info size={12} aria-hidden="true" className="mt-1 shrink-0 text-info" />
            Client keys are stored as SHA-256 hashes; the plaintext is shown once, at creation time.
          </li>
          <li className="flex gap-2">
            <Info size={12} aria-hidden="true" className="mt-1 shrink-0 text-info" />
            Account passwords are scrypt hashes, and every sign-in is a session row holding a hashed
            secret with a seven-day expiry - revoking one device never touches the others.
          </li>
          <li className="flex gap-2">
            <Info size={12} aria-hidden="true" className="mt-1 shrink-0 text-info" />
            Admin responses use the envelope <span className="mono text-text">{'{ data }'}</span> or{' '}
            <span className="mono text-text">{'{ error: { message } }'}</span> and are never cached.
          </li>
          <li className="flex gap-2">
            <Info size={12} aria-hidden="true" className="mt-1 shrink-0 text-info" />
            The console reads data only from <span className="mono text-text">{ADMIN_API_BASE}/**</span>.
          </li>
        </ul>
      </Card>
    </div>
  );
}
