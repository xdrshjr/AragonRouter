'use client';

import type { ReactNode } from 'react';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { isUnauthorized } from '@/components/console/api';
import type { UserPublic } from '@/components/console/types';
import { describeListFailure } from '@/components/console/users/user-copy';
import { UsersTable } from '@/components/console/users/UsersTable';
import type { UsersListState } from '@/components/console/users/users-list-state';

/** Everything the data area can do; grouped so the component keeps one prop object. */
export interface UsersListActions {
  /** Re-request the first page with the current filters. */
  onRefresh: () => void;
  /** Request the next keyset page. */
  onLoadMore: () => void;
  /** Re-request only the page whose append failed. */
  onRetryAppend: () => void;
  onClearFilters: () => void;
  onEdit: (row: UserPublic) => void;
  onResetPassword: (row: UserPublic) => void;
  onDelete: (row: UserPublic) => void;
}

export interface UsersListSectionProps {
  state: UsersListState;
  actions: UsersListActions;
  /** The signed-in administrator, so their own row can be labelled. */
  currentUserId: string | null;
  hasFilters: boolean;
}

/**
 * The data area of `/console/users`: table, both failure modes and the pager.
 *
 * A failure is reported where it happened instead of taking the whole surface down:
 *
 *  - a **first/refresh** failure with no rows on screen owns the area (`ErrorState`);
 *  - a **refresh** failure with rows on screen keeps the table and adds a banner, so a
 *    dropped connection never turns a loaded list into a blank page. The rows are those
 *    of the *previous* filter set, so the reducer discards the cursor and this section
 *    reports the pager as paused instead of pretending the list ended;
 *  - an **append** failure keeps every loaded row *and* the cursor, and the retry
 *    re-requests that same page - the operator's pagination position is never lost.
 */
export function UsersListSection({
  state,
  actions,
  currentUserId,
  hasFilters,
}: UsersListSectionProps): ReactNode {
  const { rows, loading, loadingMore, nextCursor, loadError, appendError } = state;
  const failure = loadError !== null && !isUnauthorized(loadError) ? loadError : null;

  return (
    <>
      {failure && rows.length > 0 ? (
        <ReplaceFailureBanner message={describeListFailure(failure)} onRetry={actions.onRefresh} />
      ) : null}

      {failure && rows.length === 0 ? (
        <div className="p-4">
          <ErrorState
            title="The account list is unavailable"
            message={describeListFailure(failure)}
            action={
              <Button size="sm" variant="secondary" onClick={actions.onRefresh}>
                Try again
              </Button>
            }
          />
        </div>
      ) : loading && rows.length === 0 ? (
        <LoadingBlock label="Loading accounts" />
      ) : rows.length === 0 && hasFilters ? (
        <EmptyState
          icon={<Users size={18} aria-hidden="true" />}
          title="No accounts match these filters"
          description="Clear the filters or search for a different username."
          action={
            <Button size="sm" variant="secondary" onClick={actions.onClearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <UsersTable
          rows={rows}
          currentUserId={currentUserId}
          onEdit={actions.onEdit}
          onResetPassword={actions.onResetPassword}
          onDelete={actions.onDelete}
        />
      )}

      {appendError !== null && !isUnauthorized(appendError) ? (
        <AppendFailureBanner
          message={describeListFailure(appendError)}
          loadedCount={rows.length}
          retrying={loadingMore}
          onRetry={actions.onRetryAppend}
        />
      ) : null}

      {rows.length > 0 || nextCursor !== null ? (
        <div
          className={
            'flex flex-wrap items-center justify-between gap-2 border-t border-border ' +
            'px-4 py-3'
          }
        >
          <p className="text-[11px] leading-4 text-muted">
            {describePager({ nextCursor, paused: failure !== null })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={actions.onLoadMore}
            disabled={nextCursor === null}
            loading={loadingMore}
            loadingLabel="Loading"
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

interface PagerCopyInput {
  nextCursor: string | null;
  /** A replace failed: the cursor is discarded, so the pager cannot continue yet. */
  paused: boolean;
}

/**
 * What the footer of the list says about the pager.
 *
 * A failed replace discards the cursor (see `users-list-state.ts`), so the button is
 * disabled; telling the operator "you have reached the end of the list" at that moment
 * would be a claim about data the panel never fetched.
 */
function describePager({ nextCursor, paused }: PagerCopyInput): string {
  if (nextCursor !== null) return 'More accounts are available.';
  if (paused) return 'Pagination resumes when the list loads again.';
  return 'You have reached the end of the list.';
}

interface ReplaceFailureBannerProps {
  message: string;
  onRetry: () => void;
}

/** A refresh that failed while rows were on screen: keep them, say so, offer a retry. */
function ReplaceFailureBanner({ message, onRetry }: ReplaceFailureBannerProps): ReactNode {
  return (
    <div
      role="alert"
      className={
        'flex flex-wrap items-center justify-between gap-2 border-b border-danger/40 ' +
        'bg-[color:var(--danger-soft)] px-4 py-2'
      }
    >
      <p className="min-w-0 text-xs leading-5 text-text">
        {message} The rows below are the last page that loaded.
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

interface AppendFailureBannerProps {
  message: string;
  loadedCount: number;
  retrying: boolean;
  onRetry: () => void;
}

/** A failed "Load more": the loaded rows stay, and the retry re-requests that page. */
function AppendFailureBanner({
  message,
  loadedCount,
  retrying,
  onRetry,
}: AppendFailureBannerProps): ReactNode {
  return (
    <div
      role="alert"
      className={
        'border-t border-danger/40 bg-[color:var(--danger-soft)] px-4 py-3 ' +
        'text-xs leading-5 text-text'
      }
    >
      <p>{message}</p>
      <p className="mt-0.5 text-[11px] leading-4 text-muted">
        The {loadedCount} accounts already loaded are still shown; only this page failed.
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-2"
        onClick={onRetry}
        loading={retrying}
        loadingLabel="Retrying"
      >
        Retry this page
      </Button>
    </div>
  );
}
