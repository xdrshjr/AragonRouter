'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { KeyRound, Plus, ShieldOff, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Input';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableMessage, TableRow } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { useAdminQuery, useAsyncAction } from '@/components/console/use-admin-query';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import { createKey, isUnauthorized, listKeys, revokeKey } from '@/components/console/api';
import { formatDateTime, formatRelativeTime } from '@/components/console/format';
import { validateKeyName } from '@/components/console/validation';
import type { ApiKeyCreated, ApiKeyPublic } from '@/components/console/types';

/**
 * `/console/keys` (C5).
 *
 * The plaintext key exists exactly once - in the `POST /api/admin/keys` response -
 * so the reveal dialog is the only place it is ever rendered, and it stays open
 * until the operator explicitly dismisses it.
 */
export function KeysPanel(): ReactNode {
  const toast = useToast();
  const keys = useAdminQuery(listKeys, []);
  useSessionExpiryRedirect(keys.error);
  const action = useAsyncAction();
  // Mutations (create/revoke) go through `useAsyncAction`, not `useAdminQuery`,
  // so the list error covers only half of the 401 paths. `api.ts` already raises
  // the global expiry signal for either, and this second call keeps the panel
  // self-sufficient if it is ever rendered outside the shell.
  useSessionExpiryRedirect(action.error);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyPublic | null>(null);

  const rows = keys.data ?? [];
  const activeCount = useMemo(() => rows.filter((row) => row.revokedAt === null).length, [rows]);

  const closeCreate = useCallback(() => {
    setCreateOpen(false);
    setName('');
    setNameError(null);
    action.reset();
  }, [action]);

  const submitCreate = useCallback(async () => {
    const problem = validateKeyName(name);
    if (problem) {
      setNameError(problem);
      return;
    }
    const result = await action.run(() => createKey(name.trim()));
    if (!result) return;
    setCreated(result);
    setCreateOpen(false);
    setName('');
    setNameError(null);
    keys.refresh();
    toast.push({ title: 'API key created', description: `“${result.name}” is ready to use.`, tone: 'success' });
  }, [action, keys, name, toast]);

  const confirmRevoke = useCallback(async () => {
    const target = revokeTarget;
    if (!target) return;
    const result = await action.run(() => revokeKey(target.id));
    if (result === null) return;
    setRevokeTarget(null);
    keys.refresh();
    toast.push({ title: 'API key revoked', description: `“${target.name}” can no longer authenticate.`, tone: 'success' });
  }, [action, keys, revokeTarget, toast]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-caps">API keys</p>
          <h2 className="mt-1 text-xl font-semibold leading-7 text-text">Client credentials</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Send a key as <span className="mono text-text">x-api-key</span> or{' '}
            <span className="mono text-text">Authorization: Bearer</span>. Only a SHA-256 hash is stored.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            // Clear any failure left over from the last revoke attempt, so the
            // create dialog never shows a message about a different action.
            action.reset();
            setCreateOpen(true);
          }}
          leftIcon={<Plus size={14} aria-hidden="true" />}
        >
          Create key
        </Button>
      </div>

      <Card flush className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4">
          <CardTitle
            eyebrow="Keys"
            description={`${activeCount} active of ${rows.length} total. Prefixes are shown so a key can be identified without revealing it.`}
          >
            Issued keys
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={keys.refresh}
            loading={keys.fetching}
            loadingLabel="Refreshing"
          >
            Refresh
          </Button>
        </div>

        {keys.loading ? (
          <LoadingBlock label="Loading keys" />
        ) : keys.error && !isUnauthorized(keys.error) ? (
          <div className="p-4">
            <ErrorState
              compact
              title="Keys are unavailable"
              message={keys.error.message}
              action={
                <Button size="sm" variant="secondary" onClick={keys.refresh}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : (
          <Table minWidth={760} caption="Issued API keys">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead align="right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableMessage colSpan={6}>
                  <EmptyState
                    compact
                    icon={<KeyRound size={18} aria-hidden="true" />}
                    title="No API keys yet"
                    description="Create a key to let a client call /api/v1/messages or /api/v1/chat/completions."
                  />
                </TableMessage>
              ) : (
                rows.map((row) => {
                  const revoked = row.revokedAt !== null;
                  return (
                    <TableRow key={row.id} hover>
                      <TableCell className="max-w-[16rem]">
                        <span className="block truncate font-medium text-text" title={row.name}>
                          {row.name}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="mono text-xs text-muted">{row.keyPrefix}…</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted" title={row.createdAt}>
                        {formatDateTime(row.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted" title={row.lastUsedAt ?? undefined}>
                        {row.lastUsedAt ? formatRelativeTime(row.lastUsedAt) : 'never'}
                      </TableCell>
                      <TableCell>
                        {revoked ? (
                          <Badge tone="danger" dot title={row.revokedAt ?? undefined}>
                            Revoked
                          </Badge>
                        ) : (
                          <Badge tone="success" dot>
                            Active
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {revoked ? (
                          <span className="text-[11px] text-muted">—</span>
                        ) : (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              // Drop any failure left over from the last action, so
                              // this confirmation never opens showing a message about
                              // a different one.
                              action.reset();
                              setRevokeTarget(row);
                            }}
                            leftIcon={<ShieldOff size={13} aria-hidden="true" />}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <p className="flex items-start gap-1.5 text-[11px] leading-4 text-muted">
        <TriangleAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
        Revoking is immediate: the relay rejects the key on the next request. The record stays in the
        list for audit purposes.
      </p>

      {/* Create */}
      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="Create an API key"
        description="Name the client that will use this key. The key itself is shown once, right after creation."
        size="sm"
        busy={action.pending}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeCreate} disabled={action.pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void submitCreate();
              }}
              loading={action.pending}
              loadingLabel="Creating"
            >
              Create key
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
          noValidate
        >
          <Field
            label="Key name"
            hint="Up to 64 characters. Shown only in this console."
            error={nameError ?? action.error?.message ?? null}
            required
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                  action.reset();
                }}
                placeholder="Production relay"
                autoComplete="off"
                autoFocus
                maxLength={80}
                invalid={nameError !== null || action.error !== null}
                aria-describedby={describedBy}
                disabled={action.pending}
              />
            )}
          </Field>
        </form>
      </Modal>

      {/* Reveal the plaintext key exactly once */}
      <Modal
        open={created !== null}
        onClose={() => {
          setCreated(null);
        }}
        title="Copy this key now"
        description="This is the only time the full key is displayed. It is stored as a SHA-256 hash and cannot be recovered."
        size="md"
        footer={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setCreated(null);
            }}
          >
            I have saved the key
          </Button>
        }
      >
        {created ? (
          <div className="space-y-3">
            <div>
              <p className="label-caps mb-1">API key</p>
              <div className="flex items-center gap-2">
                <code className="mono flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border-strong bg-surface-2 px-2.5 py-2 text-xs text-text">
                  {created.key}
                </code>
                <CopyButton
                  value={created.key}
                  label="Copy"
                  ariaLabel="Copy the new API key"
                  onResult={(ok) => {
                    toast.push(
                      ok
                        ? { title: 'Key copied to the clipboard', tone: 'success' }
                        : { title: 'Copy failed', description: 'Select the key and copy it manually.', tone: 'warning' },
                    );
                  }}
                />
              </div>
            </div>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="label-caps">Name</dt>
              <dd className="text-text">{created.name}</dd>
              <dt className="label-caps">Prefix</dt>
              <dd className="mono text-text">{created.keyPrefix}…</dd>
              <dt className="label-caps">Created</dt>
              <dd className="text-text">{formatDateTime(created.createdAt)}</dd>
            </dl>
            <p className="rounded-md border border-warning/40 bg-[color:var(--warning-soft)] px-2.5 py-2 text-[11px] leading-4 text-text">
              Store it in your client&apos;s environment. If it leaks, revoke it here and issue a new one.
            </p>
          </div>
        ) : null}
      </Modal>

      {/* Revoke. A rejected revoke is always reported - including the 401 that
          means "your session expired", which also navigates to /login. Filtering
          that one message out is what made the button look inert. */}
      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this key?"
        description={
          revokeTarget ? (
            <>
              Requests authenticated with <span className="mono text-text">{revokeTarget.keyPrefix}…</span> will fail
              with <span className="mono text-text">401</span> immediately. This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Revoke key"
        error={action.error?.message ?? null}
        destructive
        busy={action.pending}
        onCancel={() => {
          setRevokeTarget(null);
          action.reset();
        }}
        onConfirm={() => {
          void confirmRevoke();
        }}
      />
    </div>
  );
}
