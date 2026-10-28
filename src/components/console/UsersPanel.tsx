'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { FilterX, Plus, RefreshCw, Search } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardTitle } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/Modal';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/components/auth/auth-context';
import { useAsyncAction } from '@/components/console/use-admin-query';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import { deleteUser, isAbortError, listUsers } from '@/components/console/api';
import { normalizeUserSearch } from '@/components/console/validation';
import type { UserPublic, UserRole, UserStatus } from '@/components/console/types';
import {
  LIST_FAILURE_MESSAGE,
  ROLE_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  USER_PAGE_SIZE,
  USER_SEARCH_DEBOUNCE_MS,
  describeUserActionFailure,
  roleLabel,
  statusLabel,
  toApiError,
} from '@/components/console/users/user-copy';
import { UsersAccessNotice } from '@/components/console/users/UsersAccessNotice';
import { UsersListSection } from '@/components/console/users/UsersListSection';
import {
  INITIAL_USERS_LIST_STATE,
  reduceUsersList,
  type LoadMode,
} from '@/components/console/users/users-list-state';
import { CreateUserDialog } from '@/components/console/users/CreateUserDialog';
import { EditUserDialog } from '@/components/console/users/EditUserDialog';
import { ResetPasswordDialog } from '@/components/console/users/ResetPasswordDialog';
import { SelectField } from '@/components/console/users/user-fields';

/**
 * The public surface of this file is re-exported from the modules the panel was split
 * into (MAX_FILE_LINES), so every existing import keeps working unchanged.
 */
export {
  USER_PAGE_SIZE,
  USER_SEARCH_DEBOUNCE_MS,
  describeUserActionFailure,
  mergeUserPages,
} from '@/components/console/users/user-copy';
export { UsersAccessNotice } from '@/components/console/users/UsersAccessNotice';
export { UsersTable } from '@/components/console/users/UsersTable';
export { UsersListSection } from '@/components/console/users/UsersListSection';
export {
  INITIAL_USERS_LIST_STATE,
  reduceUsersList,
} from '@/components/console/users/users-list-state';
export type {
  LoadMode,
  UsersListEvent,
  UsersListState,
} from '@/components/console/users/users-list-state';

interface FiltersSummary {
  search: string;
  role: UserRole | '';
  status: UserStatus | '';
}

/**
 * `/console/users` (C-USERS-WIRE).
 *
 * Identity comes from `useAuth()` only (C-AUTH-CONTEXT). The shell already refuses to
 * mount panels for a guest or a member, and this guard makes the page correct on its
 * own too: without it, rendering the panel anywhere else would fire an admin request
 * that can only answer 401 or 403.
 */
export function UsersPanel(): ReactNode {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return <LoadingBlock label="Checking your access" />;
  }
  if (!auth.isAdmin) {
    return (
      <UsersAccessNotice
        isGuest={auth.isGuest}
        onSignIn={() => {
          auth.openLogin('login');
        }}
      />
    );
  }
  return <UsersAdminPanel currentUserId={auth.user?.id ?? null} />;
}

interface UsersAdminPanelProps {
  currentUserId: string | null;
}

/**
 * The administrator view: filters, the keyset list, the row actions and their toasts.
 *
 * List state lives in `users-list-state.ts` (`reduceUsersList`) so that "a failed
 * *append* must not discard the pages already on screen" is a tested decision rather
 * than a conditional buried in JSX.
 */
function UsersAdminPanel({ currentUserId }: UsersAdminPanelProps): ReactNode {
  const toast = useToast();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<UserRole | ''>('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [list, dispatch] = useReducer(reduceUsersList, INITIAL_USERS_LIST_STATE);
  const [reloadToken, setReloadToken] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserPublic | null>(null);
  const [resetTarget, setResetTarget] = useState<UserPublic | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserPublic | null>(null);

  const action = useAsyncAction();
  const requestId = useRef(0);
  const mounted = useRef(true);
  const appendController = useRef<AbortController | null>(null);

  useSessionExpiryRedirect(list.loadError);
  useSessionExpiryRedirect(list.appendError);
  useSessionExpiryRedirect(action.error);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      appendController.current?.abort();
    };
  }, []);

  // Debounce the search box; a keystroke must not become a query.
  useEffect(() => {
    const next = normalizeUserSearch(searchInput);
    if (next === search) return;
    const timer = setTimeout(() => {
      setSearch(next);
    }, USER_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [search, searchInput]);

  const filters = useMemo<FiltersSummary>(
    () => ({ search, role, status }),
    [search, role, status],
  );

  const load = useCallback(
    async (mode: LoadMode, cursor: string | null, signal: AbortSignal) => {
      requestId.current += 1;
      const id = requestId.current;
      dispatch({ type: 'load-started', mode });
      try {
        const page = await listUsers(
          {
            limit: USER_PAGE_SIZE,
            cursor: mode === 'append' ? cursor : null,
            search: filters.search,
            role: filters.role,
            status: filters.status,
          },
          signal,
        );
        if (!mounted.current || id !== requestId.current) return;
        dispatch({ type: 'page-loaded', mode, page });
      } catch (cause) {
        if (signal.aborted || isAbortError(cause)) return;
        if (!mounted.current || id !== requestId.current) return;
        dispatch({ type: 'load-failed', mode, error: toApiError(cause, LIST_FAILURE_MESSAGE) });
      }
    },
    [filters],
  );

  // A new filter (or a manual refresh) starts again from the first page and supersedes
  // any "Load more" still in flight - its page no longer belongs to what is on screen.
  useEffect(() => {
    const controller = new AbortController();
    appendController.current?.abort();
    void load('replace', null, controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, reloadToken]);

  const nextCursor = list.nextCursor;

  /** Load the next keyset page, or - after a failure - the page that failed. */
  const runAppend = useCallback(() => {
    if (nextCursor === null) return;
    appendController.current?.abort();
    const controller = new AbortController();
    appendController.current = controller;
    void load('append', nextCursor, controller.signal);
  }, [load, nextCursor]);

  const loadMore = useCallback(() => {
    if (list.loadingMore || list.loading) return;
    runAppend();
  }, [list.loading, list.loadingMore, runAppend]);

  const resetFilters = useCallback(() => {
    setSearchInput('');
    setSearch('');
    setRole('');
    setStatus('');
  }, []);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const handleCreated = useCallback(
    (created: UserPublic) => {
      setCreateOpen(false);
      refresh();
      const role = roleLabel(created.role).toLowerCase();
      toast.push({
        title: 'Account created',
        description: `${created.username} (${role}) can sign in now.`,
        tone: 'success',
      });
    },
    [refresh, toast],
  );

  const handleSaved = useCallback(
    (saved: UserPublic) => {
      setEditTarget(null);
      refresh();
      toast.push({
        title: 'Account updated',
        description:
          `${saved.username}: ${roleLabel(saved.role).toLowerCase()}, ` +
          `${statusLabel(saved.status).toLowerCase()}.`,
        tone: 'success',
      });
    },
    [refresh, toast],
  );

  const handlePasswordReset = useCallback(
    (target: UserPublic) => {
      setResetTarget(null);
      refresh();
      toast.push({
        title: 'Password reset',
        description: `${target.username} must sign in again with the new password.`,
        tone: 'success',
      });
    },
    [refresh, toast],
  );

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    const result = await action.run(() => deleteUser(target.id));
    if (result === null) return;
    setDeleteTarget(null);
    refresh();
    toast.push({
      title: 'Account deleted',
      description: `${target.username} can no longer sign in.`,
      tone: 'success',
    });
  }, [action, deleteTarget, refresh, toast]);

  const hasFilters =
    search.length > 0 || role.length > 0 || status.length > 0 || searchInput.length > 0;
  const inlineError = action.error ? describeUserActionFailure(action.error) : null;
  const showInlineError =
    inlineError !== null &&
    !createOpen &&
    editTarget === null &&
    resetTarget === null &&
    deleteTarget === null;

  const actions = useMemo(
    () => ({
      onRefresh: refresh,
      onLoadMore: loadMore,
      onRetryAppend: runAppend,
      onClearFilters: resetFilters,
      onEdit: (row: UserPublic) => {
        action.reset();
        setEditTarget(row);
      },
      onResetPassword: (row: UserPublic) => {
        action.reset();
        setResetTarget(row);
      },
      onDelete: (row: UserPublic) => {
        action.reset();
        setDeleteTarget(row);
      },
    }),
    [action, loadMore, refresh, resetFilters, runAppend],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-caps">Users</p>
          <h2 className="mt-1 text-xl font-semibold leading-7 text-text">Console accounts</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Registration creates <span className="mono text-text">member</span> accounts. Only an
            administrator can change a role or a status, and the server always keeps one active
            admin.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="neutral" mono>
            {list.rows.length} loaded
          </Badge>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              action.reset();
              setCreateOpen(true);
            }}
            leftIcon={<Plus size={14} aria-hidden="true" />}
          >
            Create account
          </Button>
        </div>
      </div>

      {showInlineError ? (
        <div
          role="alert"
          className={
            'rounded-md border border-danger/40 bg-[color:var(--danger-soft)] px-3 py-2 ' +
            'text-xs leading-5 text-text'
          }
        >
          {inlineError}
        </div>
      ) : null}

      <UsersFilterBar
        searchInput={searchInput}
        role={role}
        status={status}
        hasFilters={hasFilters}
        loading={list.loading}
        onSearchInput={setSearchInput}
        onRole={setRole}
        onStatus={setStatus}
        onSubmit={() => {
          setSearch(normalizeUserSearch(searchInput));
          refresh();
        }}
        onClearSearch={() => {
          setSearchInput('');
          setSearch('');
        }}
        onReset={resetFilters}
      />

      <Card flush className="overflow-hidden">
        <div
          className={
            'flex flex-wrap items-center justify-between gap-2 border-b border-border p-4'
          }
        >
          <CardTitle eyebrow="Accounts" description={describeFilters({ search, role, status })}>
            Accounts
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            loading={list.loading}
            loadingLabel="Refreshing"
            leftIcon={<RefreshCw size={13} aria-hidden="true" />}
          >
            Refresh
          </Button>
        </div>

        <UsersListSection
          state={list}
          actions={actions}
          currentUserId={currentUserId}
          hasFilters={hasFilters}
        />
      </Card>

      <p className="text-[11px] leading-4 text-muted">
        Passwords are hashed with scrypt on the server and never leave it. Deleting an account also
        deletes its sessions; disabling one ends them immediately.
      </p>

      <CreateUserDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={handleCreated}
      />

      <EditUserDialog
        target={editTarget}
        currentUserId={currentUserId}
        onClose={() => {
          setEditTarget(null);
        }}
        onSaved={handleSaved}
      />

      <ResetPasswordDialog
        target={resetTarget}
        onClose={() => {
          setResetTarget(null);
        }}
        onDone={handlePasswordReset}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this account?"
        description={
          deleteTarget ? (
            <>
              <span className="mono text-text">{deleteTarget.username}</span> loses access
              immediately and every session of the account is revoked. This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Delete account"
        destructive
        busy={action.pending}
        error={inlineError}
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

/** The card subtitle: what the current view is filtered by, in operator language. */
function describeFilters({ search, role, status }: FiltersSummary): string {
  const parts = [
    search ? `search “${search}”` : null,
    role ? `role ${role}` : null,
    status ? `status ${status}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) {
    return 'Newest first. Pagination follows the cursor the previous page returned.';
  }
  return `Filtered by ${parts.join(', ')}.`;
}

interface UsersFilterBarProps {
  searchInput: string;
  role: UserRole | '';
  status: UserStatus | '';
  hasFilters: boolean;
  loading: boolean;
  onSearchInput: (value: string) => void;
  onRole: (value: UserRole | '') => void;
  onStatus: (value: UserStatus | '') => void;
  onSubmit: () => void;
  onClearSearch: () => void;
  onReset: () => void;
}

/**
 * Search + role + status.
 *
 * Typing is debounced by the panel (the query follows the operator), while pressing
 * Apply or Enter submits immediately: an operator who is done typing should not wait
 * out the debounce window.
 */
function UsersFilterBar({
  searchInput,
  role,
  status,
  hasFilters,
  loading,
  onSearchInput,
  onRole,
  onStatus,
  onSubmit,
  onClearSearch,
  onReset,
}: UsersFilterBarProps): ReactNode {
  return (
    <Card className="p-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-[14rem] flex-1">
          <Field label="Search" caps hint="Matches the username or the display name.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={searchInput}
                onChange={(event) => {
                  onSearchInput(event.target.value);
                }}
                placeholder="username or display name"
                autoComplete="off"
                spellCheck={false}
                aria-label="Search accounts"
                aria-describedby={describedBy}
                leading={<Search size={13} aria-hidden="true" />}
                trailing={
                  searchInput.length > 0 ? (
                    <button
                      type="button"
                      onClick={onClearSearch}
                      aria-label="Clear the search"
                      className={
                        'mr-0.5 rounded p-1 text-muted hover:bg-surface hover:text-text ' +
                        'focus-visible:outline focus-visible:outline-2 ' +
                        'focus-visible:outline-brand'
                      }
                    >
                      <FilterX size={13} aria-hidden="true" />
                    </button>
                  ) : null
                }
              />
            )}
          </Field>
        </div>
        <div className="w-36">
          <SelectField
            label="Role"
            caps
            options={ROLE_FILTER_OPTIONS}
            value={role}
            ariaLabel="Filter by role"
            onChange={(value) => {
              onRole(value as UserRole | '');
            }}
          />
        </div>
        <div className="w-36">
          <SelectField
            label="Status"
            caps
            options={STATUS_FILTER_OPTIONS}
            value={status}
            ariaLabel="Filter by status"
            onChange={(value) => {
              onStatus(value as UserStatus | '');
            }}
          />
        </div>
        <div className="flex items-center gap-2 pb-0.5">
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={loading}
            loadingLabel="Applying"
          >
            Apply
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={!hasFilters}
          >
            Reset
          </Button>
        </div>
      </form>
    </Card>
  );
}
