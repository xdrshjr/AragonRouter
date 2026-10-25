'use client';

import { useCallback, type ReactNode } from 'react';
import { Info, KeyRound, Lock, Server } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardTitle } from '@/components/ui/Card';
import { ErrorState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { useAdminQuery } from '@/components/console/use-admin-query';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import { ADMIN_API_BASE, SESSION_COOKIE_NAME, isUnauthorized, listKeys, listProviders } from '@/components/console/api';

/** Session lifetime documented by C3 (seven days). */
const SESSION_TTL_DAYS = 7;

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
];

/**
 * `/console/settings` - read-only.
 *
 * There is no settings API by design: the gateway is configured through
 * environment variables and the console must never be able to read or change
 * them. What this page shows is therefore (a) the values it can derive from the
 * published contracts - key and provider counts - and (b) the *contract* of the
 * configuration (variable names, endpoint list, cookie properties), never a
 * secret value.
 */
export function SettingsPanel(): ReactNode {
  const keys = useAdminQuery(listKeys, []);
  const providers = useAdminQuery(listProviders, []);
  useSessionExpiryRedirect(keys.error ?? providers.error);

  const reload = useCallback(() => {
    keys.refresh();
    providers.refresh();
  }, [keys, providers]);

  const keyRows = keys.data ?? [];
  const providerRows = providers.data ?? [];
  const activeKeys = keyRows.filter((row) => row.revokedAt === null).length;
  const enabledProviders = providerRows.filter((row) => row.enabled).length;
  const loading = keys.loading || providers.loading;
  const failure = keys.error ?? providers.error;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-caps">Settings</p>
          <h2 className="mt-1 text-xl font-semibold leading-7 text-text">Configuration</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Read-only. The gateway is configured through the environment; this console never displays
            or edits secrets.
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

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle eyebrow="Deployment" description="Derived from the admin API, not from a config endpoint.">
            Current state
          </CardTitle>
          {loading ? (
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
                  <span className="ml-1 text-xs font-normal text-muted">/ {providerRows.length}</span>
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
