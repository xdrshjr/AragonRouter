/**
 * The list state machine of `/console/users`.
 *
 * Two kinds of load exist and they must never be confused:
 *
 *  - **replace** - the first page, a filter change or a manual refresh. `rows` is
 *    overwritten with the page the server returned.
 *  - **append** - "Load more". `rows` grows; `nextCursor` moves forward.
 *
 * A failed *append* must not touch the rows an operator has already paged through,
 * which is exactly the bug this reducer exists to prevent: the old panel kept one
 * `error` field, so a failed "Load more" replaced the whole table with an error state
 * while the rows were still in memory, and "Try again" silently jumped back to page 1.
 * Keeping the two failures in separate fields makes the honest degradation the only
 * representable outcome: `rows` and `nextCursor` survive an append failure, so the
 * inline retry can re-request the page that failed.
 *
 * A failed *replace* is the mirror image: the rows on screen are kept (they are still
 * the last page that loaded), but the cursor is discarded, because it belongs to the
 * filter set that was on screen before the failed request. Handing that cursor to an
 * append would append rows of the *new* filter that sort after a cursor of the old one
 * - two different lists mixed on one screen, under a banner claiming they are one page.
 */

import type { ApiError } from '@/components/console/api';
import type { UserPublic, UsersPage } from '@/components/console/types';
import { mergeUserPages } from '@/components/console/users/user-copy';

export type LoadMode = 'replace' | 'append';

export interface UsersListState {
  rows: UserPublic[];
  /** Cursor of the next page, or `null` at the end of the list. */
  nextCursor: string | null;
  /** A *replace* request is in flight (first load, filter change, refresh). */
  loading: boolean;
  /** An *append* request is in flight. */
  loadingMore: boolean;
  /** The last *replace* request failed; `rows` still holds the last page that loaded. */
  loadError: ApiError | null;
  /** The last *append* request failed; `rows` and `nextCursor` are untouched. */
  appendError: ApiError | null;
}

export const INITIAL_USERS_LIST_STATE: UsersListState = {
  rows: [],
  nextCursor: null,
  loading: true,
  loadingMore: false,
  loadError: null,
  appendError: null,
};

export type UsersListEvent =
  | { type: 'load-started'; mode: LoadMode }
  | { type: 'page-loaded'; mode: LoadMode; page: UsersPage }
  | { type: 'load-failed'; mode: LoadMode; error: ApiError };

/**
 * Apply one list event.
 *
 * @param state - current list state
 * @param event - what the request did
 * @returns the next state; the previous object is never mutated
 */
export function reduceUsersList(state: UsersListState, event: UsersListEvent): UsersListState {
  switch (event.type) {
    case 'load-started':
      return startLoad(state, event.mode);
    case 'page-loaded':
      return applyPage(state, event.mode, event.page);
    case 'load-failed':
      return applyFailure(state, event.mode, event.error);
  }
}

function startLoad(state: UsersListState, mode: LoadMode): UsersListState {
  if (mode === 'append') {
    return { ...state, loadingMore: true, appendError: null };
  }
  // A new first page invalidates both failures *and* any append still in flight: the
  // page that append was about to add no longer belongs to what is on screen.
  return { ...state, loading: true, loadingMore: false, loadError: null, appendError: null };
}

function applyPage(state: UsersListState, mode: LoadMode, page: UsersPage): UsersListState {
  if (mode === 'append') {
    return {
      ...state,
      loadingMore: false,
      appendError: null,
      rows: mergeUserPages(state.rows, page.data),
      nextCursor: page.nextCursor,
    };
  }
  return {
    ...state,
    loading: false,
    loadError: null,
    appendError: null,
    rows: page.data,
    nextCursor: page.nextCursor,
  };
}

function applyFailure(state: UsersListState, mode: LoadMode, error: ApiError): UsersListState {
  if (mode === 'append') {
    // Deliberately keeps `rows` and `nextCursor`: the operator stays on the page they
    // reached and the inline retry re-requests exactly the page that failed.
    return { ...state, loadingMore: false, appendError: error };
  }
  // A failed replace means the rows on screen belong to the view that was requested
  // *before* this one (a filter change, a search, a refresh). The cursor in hand was
  // minted for that older view, so paging past it would append rows of the new view
  // that sort after a cursor of the old one and mix two different lists on screen.
  // Dropping the cursor disables "Load more" until a replace succeeds again; the rows
  // that did load stay, and the banner names them as the last page that loaded.
  return { ...state, loading: false, loadingMore: false, loadError: error, nextCursor: null };
}
