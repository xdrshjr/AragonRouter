/**
 * The keyset list state machine of `/console/users` (WP users-admin-ui).
 *
 * These are the decisions the data area makes when a request fails, driven directly:
 * a failed *append* must keep the rows and the cursor an operator already paged
 * through, a failed *replace* must keep the last page that loaded, and "Load more" must
 * never be offered a cursor that belongs to a view which is no longer on screen.
 * Rendering `UsersListSection` statically then proves what that state means on screen
 * (the table stays, an inline retry appears, the blank error surface is not used).
 *
 * No DOM is involved: the repository forbids adding jsdom/testing-library.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError, buildUsersQuery } from '@/components/console/api';
import type { UserPublic } from '@/components/console/types';
import { USER_PAGE_SIZE, mergeUserPages } from '@/components/console/users/user-copy';
import {
  INITIAL_USERS_LIST_STATE,
  reduceUsersList,
} from '@/components/console/users/users-list-state';
import type { UsersListState } from '@/components/console/users/users-list-state';
import { UsersListSection } from '@/components/console/users/UsersListSection';
import type { UsersListActions } from '@/components/console/users/UsersListSection';
import { normalizeUserSearch } from '@/components/console/validation';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

function userRow(overrides: Partial<UserPublic> = {}): UserPublic {
  return {
    id: 'user-1',
    username: 'member-one',
    displayName: 'Member One',
    role: 'member',
    status: 'active',
    createdAt: '2025-01-02T03:04:05.000Z',
    updatedAt: '2025-01-02T03:04:05.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

const ADMIN_ROW = userRow({
  id: 'user-admin',
  username: 'admin',
  displayName: 'Operator',
  role: 'admin',
  lastLoginAt: '2025-01-03T00:00:00.000Z',
});

const MEMBER_ROW = userRow();

/** Actions that do nothing: these renders only assert what the state produces. */
const NOOP_LIST_ACTIONS: UsersListActions = {
  onRefresh: () => undefined,
  onLoadMore: () => undefined,
  onRetryAppend: () => undefined,
  onClearFilters: () => undefined,
  onEdit: () => undefined,
  onResetPassword: () => undefined,
  onDelete: () => undefined,
};

/** Drive the reducer to "the first page arrived". */
function loadedListState(rows: UserPublic[], nextCursor: string | null): UsersListState {
  const started = reduceUsersList(INITIAL_USERS_LIST_STATE, {
    type: 'load-started',
    mode: 'replace',
  });
  return reduceUsersList(started, {
    type: 'page-loaded',
    mode: 'replace',
    page: { data: rows, nextCursor },
  });
}

/** Drive the reducer to "a page loaded, then Load more failed". */
function appendFailedState(rows: UserPublic[], nextCursor: string): UsersListState {
  const loadingMore = reduceUsersList(loadedListState(rows, nextCursor), {
    type: 'load-started',
    mode: 'append',
  });
  return reduceUsersList(loadingMore, {
    type: 'load-failed',
    mode: 'append',
    error: new ApiError('Connection lost', 0, 'network'),
  });
}

describe('filters and keyset pagination', () => {
  it('turns the debounced search and the two selects into the documented query', () => {
    const query = new URLSearchParams(
      buildUsersQuery({
        limit: USER_PAGE_SIZE,
        search: normalizeUserSearch('  ali ce  '),
        role: 'member',
        status: 'disabled',
      }),
    );
    expect(query.get('limit')).toBe(String(USER_PAGE_SIZE));
    expect(query.get('search')).toBe('ali ce');
    expect(query.get('role')).toBe('member');
    expect(query.get('status')).toBe('disabled');
    // No filter means no parameter, so the server sends its own default page.
    expect(buildUsersQuery({ role: '', status: '', search: '' })).toBe('');
  });

  it('normalises a pasted search term', () => {
    expect(normalizeUserSearch('   spaced   ')).toBe('spaced');
    expect(normalizeUserSearch('a\u0000b')).toBe('ab');
    expect(normalizeUserSearch(undefined)).toBe('');
    expect(normalizeUserSearch('x'.repeat(200)).length).toBe(64);
  });

  it('merges "Load more" pages without duplicating an id', () => {
    const page1 = [userRow({ id: 'a' }), userRow({ id: 'b' })];
    // A row can repeat when an account is created between two requests.
    const page2 = [userRow({ id: 'b' }), userRow({ id: 'c' })];
    const merged = mergeUserPages(page1, page2);
    expect(merged.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    // The incoming row never replaces the one already rendered.
    expect(merged[1]).toBe(page1[1]);
    expect(mergeUserPages([], [])).toEqual([]);
  });

  it('wires the debounce and the cursor into the panel source', () => {
    const panel = read('components/console/UsersPanel.tsx');
    const copy = read('components/console/users/user-copy.ts');
    const listState = read('components/console/users/users-list-state.ts');
    const section = read('components/console/users/UsersListSection.tsx');
    expect(copy).toMatch(/export const USER_SEARCH_DEBOUNCE_MS = \d+/);
    expect(panel).toContain('setTimeout');
    expect(panel).toContain('clearTimeout');
    expect(listState).toContain('mergeUserPages');
    expect(listState).toContain('nextCursor: page.nextCursor');
    expect(section).toContain('Load more');
    expect(panel).toContain("cursor: mode === 'append' ? cursor : null");
    // No second HTTP client: everything goes through the shared typed client.
    for (const source of [panel, copy, listState, section]) {
      expect(source).not.toMatch(/\bfetch\(/);
    }
  });
});

describe('rework 1.2: a failed "Load more" keeps the pages already loaded', () => {
  it('keeps the rows and the cursor instead of replacing them with an error', () => {
    const failed = appendFailedState([ADMIN_ROW, MEMBER_ROW], 'cursor-2');

    expect(failed.rows.map((row) => row.id)).toEqual([ADMIN_ROW.id, MEMBER_ROW.id]);
    // The cursor survives, so the retry re-requests exactly the page that failed.
    expect(failed.nextCursor).toBe('cursor-2');
    expect(failed.appendError).not.toBeNull();
    // A failed append is never promoted to a whole-surface failure.
    expect(failed.loadError).toBeNull();
    expect(failed.loadingMore).toBe(false);
  });

  it('renders the loaded rows plus an inline retry, not a blank error surface', () => {
    const markup = renderToStaticMarkup(
      <UsersListSection
        state={appendFailedState([ADMIN_ROW, MEMBER_ROW], 'cursor-2')}
        actions={NOOP_LIST_ACTIONS}
        currentUserId={ADMIN_ROW.id}
        hasFilters={false}
      />,
    );
    expect(markup).toContain('<table');
    expect(markup).toContain('member-one');
    expect(markup).toContain('Retry this page');
    expect(markup).toContain('The 2 accounts already loaded are still shown');
    expect(markup).not.toContain('The account list is unavailable');
  });

  it('merges the retried page on top of the rows instead of restarting at page 1', () => {
    const failed = appendFailedState([ADMIN_ROW], 'cursor-1');
    const retried = reduceUsersList(
      reduceUsersList(failed, { type: 'load-started', mode: 'append' }),
      {
        type: 'page-loaded',
        mode: 'append',
        page: { data: [MEMBER_ROW], nextCursor: null },
      },
    );
    expect(retried.rows.map((row) => row.id)).toEqual([ADMIN_ROW.id, MEMBER_ROW.id]);
    expect(retried.appendError).toBeNull();
    expect(retried.nextCursor).toBeNull();
  });

  it('still uses the full error surface when the first page never arrived', () => {
    const failed = reduceUsersList(
      reduceUsersList(INITIAL_USERS_LIST_STATE, { type: 'load-started', mode: 'replace' }),
      {
        type: 'load-failed',
        mode: 'replace',
        error: new ApiError('Connection lost', 0, 'network'),
      },
    );
    const markup = renderToStaticMarkup(
      <UsersListSection
        state={failed}
        actions={NOOP_LIST_ACTIONS}
        currentUserId={null}
        hasFilters={false}
      />,
    );
    expect(markup).toContain('The account list is unavailable');
    expect(markup).not.toContain('<table');
  });

  it('keeps a loaded page when only a refresh fails, and clears it on the next load', () => {
    const loaded = loadedListState([MEMBER_ROW], null);
    const refreshFailed = reduceUsersList(
      reduceUsersList(loaded, { type: 'load-started', mode: 'replace' }),
      {
        type: 'load-failed',
        mode: 'replace',
        error: new ApiError('Connection lost', 0, 'network'),
      },
    );
    expect(refreshFailed.rows.map((row) => row.id)).toEqual([MEMBER_ROW.id]);
    const markup = renderToStaticMarkup(
      <UsersListSection
        state={refreshFailed}
        actions={NOOP_LIST_ACTIONS}
        currentUserId={null}
        hasFilters={false}
      />,
    );
    expect(markup).toContain('member-one');
    expect(markup).toContain('The rows below are the last page that loaded.');

    // A filter change starts from scratch and drops both failures.
    const retrying = reduceUsersList(refreshFailed, { type: 'load-started', mode: 'replace' });
    expect(retrying.loadError).toBeNull();
    expect(retrying.appendError).toBeNull();
    expect(retrying.rows).toHaveLength(1);
  });
});

/**
 * Rework 2.1 (regression).
 *
 * A *replace* is how the panel switches views: a new search term, a role or status
 * filter, or an explicit refresh. When that request fails, the rows on screen still
 * belong to the view that was requested before it, but the reducer used to keep
 * `nextCursor` - a cursor minted for that older view. "Load more" stayed clickable
 * (`nextCursor !== null`), so the next append mixed rows of the *new* filter that sort
 * after a cursor of the *old* one into a table the banner described as "the last page
 * that loaded". The cursor is now dropped on a failed replace, which makes that state
 * unrepresentable instead of merely unlikely.
 */
describe('rework 2.1: a failed replace never leaves a stale cursor on screen', () => {
  /** A page loaded with a cursor, then a filter change whose request failed. */
  function replaceFailedState(): UsersListState {
    const loaded = loadedListState([ADMIN_ROW, MEMBER_ROW], 'cursor-old');
    return reduceUsersList(
      reduceUsersList(loaded, { type: 'load-started', mode: 'replace' }),
      {
        type: 'load-failed',
        mode: 'replace',
        error: new ApiError('Connection lost', 0, 'network'),
      },
    );
  }

  it('drops the cursor of the previous view and keeps the rows that did load', () => {
    const failed = replaceFailedState();

    expect(failed.nextCursor).toBeNull();
    expect(failed.rows.map((row) => row.id)).toEqual([ADMIN_ROW.id, MEMBER_ROW.id]);
    expect(failed.loadError).not.toBeNull();
    expect(failed.loadingMore).toBe(false);
    // A failed replace is not an append failure: no inline append banner.
    expect(failed.appendError).toBeNull();
    // The panel asks the state for a cursor before it appends anything, so a null
    // cursor means no request can be sent with the old page cursor.
    expect(read('components/console/UsersPanel.tsx')).toContain('if (nextCursor === null) return;');
  });

  it('renders the pager as paused instead of claiming the list ended', () => {
    const markup = renderToStaticMarkup(
      <UsersListSection
        state={replaceFailedState()}
        actions={NOOP_LIST_ACTIONS}
        currentUserId={ADMIN_ROW.id}
        hasFilters={true}
      />,
    );

    expect(markup).toContain('member-one');
    expect(markup).toContain('The rows below are the last page that loaded.');
    expect(markup).toContain('Pagination resumes when the list loads again.');
    expect(markup).not.toContain('More accounts are available.');
    // "End of the list" would be a claim about rows the panel never fetched.
    expect(markup).not.toContain('You have reached the end of the list.');
    // The button is still rendered, but disabled - the same gate `runAppend` applies.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Load more/);
  });

  it('re-enables pagination only with the cursor a successful replace returns', () => {
    const failed = replaceFailedState();

    const retried = reduceUsersList(
      reduceUsersList(failed, { type: 'load-started', mode: 'replace' }),
      {
        type: 'page-loaded',
        mode: 'replace',
        page: { data: [MEMBER_ROW], nextCursor: 'cursor-new' },
      },
    );
    expect(retried.loadError).toBeNull();
    expect(retried.nextCursor).toBe('cursor-new');

    // Only now can a page be appended, and it appends onto the fresh rows.
    const appended = reduceUsersList(
      reduceUsersList(retried, { type: 'load-started', mode: 'append' }),
      {
        type: 'page-loaded',
        mode: 'append',
        page: { data: [ADMIN_ROW], nextCursor: null },
      },
    );
    expect(appended.rows.map((row) => row.id)).toEqual([MEMBER_ROW.id, ADMIN_ROW.id]);
    expect(appended.nextCursor).toBeNull();
  });

  it('still reports an honest end of list when nothing failed', () => {
    const markup = renderToStaticMarkup(
      <UsersListSection
        state={loadedListState([MEMBER_ROW], null)}
        actions={NOOP_LIST_ACTIONS}
        currentUserId={null}
        hasFilters={false}
      />,
    );
    expect(markup).toContain('You have reached the end of the list.');
    expect(markup).not.toContain('Pagination resumes');
  });

  it('cannot be re-entered by an append that was in flight when the replace started', () => {
    const loaded = loadedListState([MEMBER_ROW], 'cursor-old');
    // "Load more" starts, then a filter change supersedes it before it answers.
    const appendInFlight = reduceUsersList(loaded, { type: 'load-started', mode: 'append' });
    const superseded = reduceUsersList(appendInFlight, { type: 'load-started', mode: 'replace' });
    expect(superseded.loadingMore).toBe(false);

    // The panel drops the late answer of the superseded request (stale request id),
    // so the reducer never sees it; the guard is asserted where it is written.
    const panel = read('components/console/UsersPanel.tsx');
    expect(panel).toContain('if (!mounted.current || id !== requestId.current) return;');
    expect(panel).toContain('appendController.current?.abort();');
  });
});
