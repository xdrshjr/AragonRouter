'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pencil, Plug, Plus, Server, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardTitle } from '@/components/ui/Card';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Input';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Switch } from '@/components/ui/Switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableMessage, TableRow } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { useAdminQuery, useAsyncAction } from '@/components/console/use-admin-query';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import {
  createProvider,
  deleteProvider,
  isUnauthorized,
  listProviders,
  testProvider,
  updateProvider,
} from '@/components/console/api';
import { formatDateTime, truncateEnd } from '@/components/console/format';
import {
  EMPTY_PROVIDER_FORM,
  buildCreateProviderPayload,
  buildUpdateProviderPayload,
  hasErrors,
  validateProviderForm,
  type ProviderFormValues,
  type ValidationErrors,
} from '@/components/console/validation';
import { PROTOCOLS, type ProviderPublic, type ProviderTestResult, type Protocol } from '@/components/console/types';

const PROTOCOL_OPTIONS = PROTOCOLS.map((protocol) => ({
  value: protocol,
  label: protocol === 'anthropic' ? 'Anthropic messages' : 'OpenAI compatible',
}));

type DialogMode = { kind: 'create' } | { kind: 'edit'; provider: ProviderPublic };

/**
 * `/console/providers` (C6).
 *
 * Create, edit, delete, toggle `enabled` and probe `GET {baseUrl}/v1/models`
 * through the gateway. The upstream credential is write-only: the list shows
 * `maskedKey`, editing leaves the field blank to keep the stored ciphertext.
 */
export function ProvidersPanel(): ReactNode {
  const toast = useToast();
  const providers = useAdminQuery(listProviders, []);
  useSessionExpiryRedirect(providers.error);
  const action = useAsyncAction();
  // Mutations (create/update/delete/toggle/test) report through `action`, not
  // `providers.error`. `api.ts` raises the global expiry signal for either, and
  // this keeps the panel correct on its own (see `KeysPanel` for the same pair).
  useSessionExpiryRedirect(action.error);

  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [form, setForm] = useState<ProviderFormValues>(EMPTY_PROVIDER_FORM);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [deleteTarget, setDeleteTarget] = useState<ProviderPublic | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});

  const rows = providers.data ?? [];
  const enabledCount = useMemo(() => rows.filter((row) => row.enabled).length, [rows]);
  const editing = dialog?.kind === 'edit' ? dialog.provider : null;

  const openCreate = useCallback(() => {
    setDialog({ kind: 'create' });
    setForm({ ...EMPTY_PROVIDER_FORM });
    setErrors({});
    action.reset();
  }, [action]);

  const openEdit = useCallback(
    (provider: ProviderPublic) => {
      setDialog({ kind: 'edit', provider });
      setForm({
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        // Blank: the stored credential is kept unless the operator types a new one.
        apiKey: '',
        enabled: provider.enabled,
      });
      setErrors({});
      action.reset();
    },
    [action],
  );

  const closeDialog = useCallback(() => {
    setDialog(null);
    setErrors({});
    action.reset();
  }, [action]);

  const submit = useCallback(async () => {
    const mode = dialog?.kind === 'edit' ? 'edit' : 'create';
    const found = validateProviderForm(form, { mode });
    if (hasErrors(found)) {
      setErrors(found);
      return;
    }
    setErrors({});
    if (mode === 'create') {
      const result = await action.run(() => createProvider(buildCreateProviderPayload(form)));
      if (!result) return;
      setDialog(null);
      providers.refresh();
      toast.push({ title: 'Provider added', description: result.name, tone: 'success' });
      return;
    }
    const target = dialog?.kind === 'edit' ? dialog.provider : null;
    if (!target) return;
    const result = await action.run(() => updateProvider(target.id, buildUpdateProviderPayload(form)));
    if (!result) return;
    setDialog(null);
    providers.refresh();
    toast.push({ title: 'Provider updated', description: result.name, tone: 'success' });
  }, [action, dialog, form, providers, toast]);

  const toggleEnabled = useCallback(
    async (provider: ProviderPublic, enabled: boolean) => {
      setToggling(provider.id);
      const result = await action.run(() => updateProvider(provider.id, { enabled }));
      setToggling(null);
      if (!result) return;
      providers.refresh();
      toast.push({
        title: enabled ? 'Provider enabled' : 'Provider disabled',
        description: provider.name,
        tone: enabled ? 'success' : 'warning',
      });
    },
    [action, providers, toast],
  );

  const runTest = useCallback(
    async (provider: ProviderPublic) => {
      setTesting(provider.id);
      const result = await action.run(() => testProvider(provider.id));
      setTesting(null);
      if (!result) return;
      setTestResults((current) => ({ ...current, [provider.id]: result }));
      toast.push({
        title: result.ok ? 'Connection OK' : 'Connection failed',
        description: result.message,
        tone: result.ok ? 'success' : 'danger',
      });
    },
    [action, toast],
  );

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    const result = await action.run(() => deleteProvider(target.id));
    if (result === null) return;
    setDeleteTarget(null);
    providers.refresh();
    toast.push({ title: 'Provider deleted', description: target.name, tone: 'success' });
  }, [action, deleteTarget, providers, toast]);

  // Every failed action is surfaced, including the 401 that means "your session
  // expired" (the shell navigates to /login as well). Dropping that one message
  // here is what made 'Test', the `enabled` toggle and the dialog submit look
  // inert, so the filter is gone on purpose.
  const inlineError = action.error?.message ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-caps">Providers</p>
          <h2 className="mt-1 text-xl font-semibold leading-7 text-text">Upstreams</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Credentials are sealed with AES-256-GCM before they touch the database and are never
            returned by this console.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={openCreate}
          leftIcon={<Plus size={14} aria-hidden="true" />}
        >
          Add provider
        </Button>
      </div>

      {inlineError && dialog === null && deleteTarget === null ? (
        <div
          role="alert"
          className="rounded-md border border-danger/40 bg-[color:var(--danger-soft)] px-3 py-2 text-xs text-text"
        >
          {inlineError}
        </div>
      ) : null}

      <Card flush className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4">
          <CardTitle
            eyebrow="Routing"
            description={`${enabledCount} of ${rows.length} enabled. The oldest enabled provider for a protocol serves the traffic.`}
          >
            Configured upstreams
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={providers.refresh} loading={providers.fetching} loadingLabel="Refreshing">
            Refresh
          </Button>
        </div>

        {providers.loading ? (
          <LoadingBlock label="Loading providers" />
        ) : providers.error && !isUnauthorized(providers.error) ? (
          <div className="p-4">
            <ErrorState
              compact
              title="Providers are unavailable"
              message={providers.error.message}
              action={
                <Button size="sm" variant="secondary" onClick={providers.refresh}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : (
          <Table minWidth={900} caption="Configured upstream providers">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Health</TableHead>
                <TableHead align="right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableMessage colSpan={7}>
                  <EmptyState
                    compact
                    icon={<Server size={18} aria-hidden="true" />}
                    title="No providers configured"
                    description="Add an Anthropic or OpenAI-compatible upstream before clients send traffic."
                  />
                </TableMessage>
              ) : (
                rows.map((provider) => {
                  const result = testResults[provider.id];
                  return (
                    <TableRow key={provider.id} hover>
                      <TableCell className="max-w-[14rem]">
                        <span className="block truncate font-medium text-text" title={provider.name}>
                          {provider.name}
                        </span>
                        <span className="block text-[11px] text-muted" title={provider.createdAt}>
                          added {formatDateTime(provider.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge tone={provider.protocol === 'anthropic' ? 'brand' : 'info'}>
                          {provider.protocol}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[18rem]">
                        <span className="mono block truncate text-xs text-muted" title={provider.baseUrl}>
                          {truncateEnd(provider.baseUrl, 48)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="mono text-xs text-muted" title="Masked for safety">
                          {provider.maskedKey || '••••'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={provider.enabled}
                          onCheckedChange={(next) => {
                            void toggleEnabled(provider, next);
                          }}
                          label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
                          pending={toggling === provider.id}
                          disabled={action.pending && toggling !== provider.id}
                          size="sm"
                        />
                      </TableCell>
                      <TableCell>
                        {result ? (
                          <Badge tone={result.ok ? 'success' : 'danger'} dot title={result.message}>
                            {result.ok ? 'Reachable' : 'Failed'}
                          </Badge>
                        ) : (
                          <span className="text-[11px] text-muted">untested</span>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              void runTest(provider);
                            }}
                            loading={testing === provider.id}
                            loadingLabel="Testing"
                            leftIcon={<Plug size={13} aria-hidden="true" />}
                          >
                            Test
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              openEdit(provider);
                            }}
                            aria-label={`Edit ${provider.name}`}
                            leftIcon={<Pencil size={13} aria-hidden="true" />}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              // Drop any failure left over from the last toggle/test,
                              // so this confirmation never opens showing a message
                              // about a different action.
                              action.reset();
                              setDeleteTarget(provider);
                            }}
                            aria-label={`Delete ${provider.name}`}
                            leftIcon={<Trash2 size={13} aria-hidden="true" />}
                          >
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <Modal
        open={dialog !== null}
        onClose={closeDialog}
        title={editing ? 'Edit provider' : 'Add provider'}
        description={
          editing
            ? 'Leave the API key blank to keep the stored credential.'
            : 'The upstream key is encrypted at rest and never displayed again.'
        }
        size="md"
        busy={action.pending}
        error={inlineError}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeDialog} disabled={action.pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void submit();
              }}
              loading={action.pending}
              loadingLabel="Saving"
            >
              {editing ? 'Save changes' : 'Add provider'}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
          className="space-y-3"
        >
          <Field label="Name" error={errors.name ?? null} required hint="Up to 64 characters.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={form.name}
                onChange={(event) => {
                  setForm((current) => ({ ...current, name: event.target.value }));
                  setErrors((current) => ({ ...current, name: '' }));
                }}
                placeholder="Anthropic production"
                autoComplete="off"
                maxLength={80}
                invalid={Boolean(errors.name)}
                aria-describedby={describedBy}
                disabled={action.pending}
                autoFocus
              />
            )}
          </Field>

          <Field label="Protocol" error={errors.protocol ?? null} required hint="Determines the upstream auth header and body format.">
            {({ id, describedBy }) => (
              <Select
                id={id}
                options={PROTOCOL_OPTIONS}
                value={form.protocol}
                onChange={(event) => {
                  setForm((current) => ({ ...current, protocol: event.target.value as Protocol }));
                  setErrors((current) => ({ ...current, protocol: '' }));
                }}
                invalid={Boolean(errors.protocol)}
                aria-describedby={describedBy}
                disabled={action.pending}
              />
            )}
          </Field>

          <Field
            label="Base URL"
            error={errors.baseUrl ?? null}
            required
            hint="Absolute http(s) URL without a trailing path. The relay appends /v1/… itself."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={form.baseUrl}
                onChange={(event) => {
                  setForm((current) => ({ ...current, baseUrl: event.target.value }));
                  setErrors((current) => ({ ...current, baseUrl: '' }));
                }}
                placeholder="https://api.anthropic.com"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                invalid={Boolean(errors.baseUrl)}
                aria-describedby={describedBy}
                disabled={action.pending}
                mono
              />
            )}
          </Field>

          <Field
            label="Upstream API key"
            error={errors.apiKey ?? null}
            required={editing === null}
            hint={
              editing
                ? `Currently ${editing.maskedKey || '••••'}. Leave blank to keep it.`
                : 'Stored encrypted; only a masked form is ever shown.'
            }
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="password"
                value={form.apiKey}
                onChange={(event) => {
                  setForm((current) => ({ ...current, apiKey: event.target.value }));
                  setErrors((current) => ({ ...current, apiKey: '' }));
                }}
                placeholder={editing ? 'Leave blank to keep the current key' : 'sk-…'}
                autoComplete="new-password"
                spellCheck={false}
                invalid={Boolean(errors.apiKey)}
                aria-describedby={describedBy}
                disabled={action.pending}
                mono
              />
            )}
          </Field>

            <Field label="Availability" hint="Disabled providers are skipped by the relay.">
              {({ id, describedBy }) => (
                <Switch
                  id={id}
                  checked={form.enabled}
                  onCheckedChange={(next) => {
                    setForm((current) => ({ ...current, enabled: next }));
                  }}
                  label="Provider enabled"
                  description={form.enabled ? 'Enabled, serving traffic' : 'Disabled, skipped by the relay'}
                  disabled={action.pending}
                  describedBy={describedBy}
                />
              )}
            </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this provider?"
        description={
          deleteTarget ? (
            <>
              <span className="mono text-text">{deleteTarget.name}</span> and its encrypted credential will be
              removed. Requests routed to it will fail until another provider is enabled.
            </>
          ) : null
        }
        confirmLabel="Delete provider"
        error={inlineError}
        destructive
        busy={action.pending}
        onCancel={() => {
          setDeleteTarget(null);
          action.reset();
        }}
        onConfirm={() => {
          void confirmDelete();
        }}
      />
    </div>
  );
}
