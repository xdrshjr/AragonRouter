/**
 * How the account list reports a failure it is *not* responsible for.
 *
 * `tests/users-admin-ui/users-list-state.test.tsx` covers what a lost connection does
 * (keep the rows, retry the page). It does not cover the two status codes the shell
 * owns, and those are the security-relevant ones:
 *
 *  - **401** means "the session expired". `api.ts` raises the global signal and
 *    `AuthGuard` opens the sign-in dialog, so the data area must say *nothing*: a second
 *    banner telling the operator "unauthorized" is noise on top of the dialog the shell
 *    already opened, and it invites them to retry a request that can never succeed.
 *  - **403** means "signed in, not an administrator". The raw API sentence must never
 *    reach the screen; the operator gets the same "administrator access required" copy
 *    the shell uses, and no "Try again" that would only produce another 403.
 *
 * Everything here is rendered from the presentational section with a crafted state, so
 * each branch is asserted on the markup an operator actually receives.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ADMIN_REQUIRED_MESSAGE, ApiError } from '@/components/console/api';
import type { UserPublic } from '@/components/console/types';
import {
  INITIAL_USERS_LIST_STATE,
  reduceUsersList,
} from '@/components/console/users/users-list-state';
import type { UsersListState } from '@/components/console/users/users-list-state';
import { UsersListSection } from '@/components/console/users/UsersListSection';
import type { UsersListActions } from '@/components/console/users/UsersListSection';

const NOOP_ACTIONS: UsersListActions = {
  onRefresh: () => undefined,
  onLoadMore: () => undefined,
  onRetryAppend: () => undefined,
  onClearFilters: () => undefined,
  onEdit: () => undefined,
  onResetPassword: () => undefined,
  onDelete: () => undefined,
};

function row(overrides: Partial<UserPublic> = {}): UserPublic {
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

const ROWS = [
  row({ id: 'user-1', username: 'member-one' }),
  row({ id: 'user-2', username: 'member-two' }),
];

/** The body a 401 carries; `api.ts` is what turns it into the shell's dialog. */
const UNAUTHORIZED = new ApiError('unauthorized', 401, 'http');
/** The body a 403 carries: a signed-in account without the administrator role. */
const FORBIDDEN = new ApiError('forbidden', 403, 'http');

/** The first page arrived, then a second request of `mode` failed with `error`. */
function stateWithFailure(
  mode: 'replace' | 'append',
  error: ApiError,
  rows: UserPublic[] = ROWS,
): UsersListState {
  const loaded = reduceUsersList(
    reduceUsersList(INITIAL_USERS_LIST_STATE, { type: 'load-started', mode: 'replace' }),
    {
      type: 'page-loaded',
      mode: 'replace',
      page: { data: rows, nextCursor: '1700000000000|user-2' },
    },
  );
  const started = reduceUsersList(loaded, { type: 'load-started', mode });
  return reduceUsersList(started, { type: 'load-failed', mode, error });
}

function render(state: UsersListState, hasFilters = false): string {
  return renderToStaticMarkup(
    <UsersListSection
      state={state}
      actions={NOOP_ACTIONS}
      currentUserId="user-9"
      hasFilters={hasFilters}
    />,
  );
}

describe('a 401 belongs to the shell: the list stays silent', () => {
  it('shows no banner and no retry when the session expired during a load', () => {
    const html = render(stateWithFailure('replace', UNAUTHORIZED));
    expect(html).not.toContain('unauthorized');
    expect(html).not.toContain('role="alert"');
    // The rows that did load are still on screen: the operator keeps their place.
    expect(html).toContain('member-one');
    expect(html).toContain('member-two');
  });

  it('shows no append banner when the session expired during "Load more"', () => {
    const html = render(stateWithFailure('append', UNAUTHORIZED));
    expect(html).not.toContain('unauthorized');
    expect(html).not.toContain('Retry this page');
    expect(html).toContain('member-two');
  });

  it('falls back to the full error surface only when nothing loaded and it is not a 401', () => {
    const empty = stateWithFailure('replace', UNAUTHORIZED, []);
    const html = render(empty);
    // No rows, no list-level complaint: the sign-in dialog is the only correct answer.
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('The account list is unavailable');
  });
});

describe('a 403 is translated, never echoed', () => {
  it('replaces the raw forbidden sentence with the console copy', () => {
    const html = render(stateWithFailure('replace', FORBIDDEN, []));
    expect(html).toContain('The account list is unavailable');
    expect(html).toContain(ADMIN_REQUIRED_MESSAGE);
    expect(html).not.toContain('>forbidden<');
    expect(html).not.toMatch(/forbidden/i);
  });

  it('keeps the rows and names the reason when a refresh is refused', () => {
    const html = render(stateWithFailure('replace', FORBIDDEN));
    expect(html).toContain(ADMIN_REQUIRED_MESSAGE);
    expect(html).toContain('The rows below are the last page that loaded.');
    expect(html).toContain('member-one');
  });
});

describe('the remaining states are honest about what is on screen', () => {
  it('offers the clear-filters action when a filter is what emptied the list', () => {
    const state = reduceUsersList(
      reduceUsersList(INITIAL_USERS_LIST_STATE, { type: 'load-started', mode: 'replace' }),
      { type: 'page-loaded', mode: 'replace', page: { data: [], nextCursor: null } },
    );
    const html = render(state, true);
    expect(html).toContain('No accounts match these filters');
    expect(html).toContain('Clear filters');
  });

  it('explains an empty installation instead of blaming filters that are not set', () => {
    const state = reduceUsersList(
      reduceUsersList(INITIAL_USERS_LIST_STATE, { type: 'load-started', mode: 'replace' }),
      { type: 'page-loaded', mode: 'replace', page: { data: [], nextCursor: null } },
    );
    const html = render(state, false);
    expect(html).toContain('No accounts match this view');
    expect(html).not.toContain('Clear filters');
    expect(html).not.toContain('Load more');
  });

  it('counts the rows an append failure kept and disables "Load more" at the end', () => {
    const failed = stateWithFailure('append', new ApiError('gateway timeout', 504, 'http'));
    const failedHtml = render(failed);
    expect(failedHtml).toContain('Retry this page');
    expect(failedHtml).toContain(`The ${ROWS.length} accounts already loaded are still shown`);
    // The cursor survived the failed append, so the pager is still usable.
    expect(failedHtml).toContain('More accounts are available.');

    const ended = reduceUsersList(
      reduceUsersList(INITIAL_USERS_LIST_STATE, { type: 'load-started', mode: 'replace' }),
      { type: 'page-loaded', mode: 'replace', page: { data: ROWS, nextCursor: null } },
    );
    const endedHtml = render(ended);
    expect(endedHtml).toContain('You have reached the end of the list.');
    expect(endedHtml).toMatch(/<button[^>]*disabled[^>]*>Load more<\/button>/);
  });

  it('marks the signed-in administrator own row, so a self-edit is recognizable', () => {
    const state = reduceUsersList(
      reduceUsersList(INITIAL_USERS_LIST_STATE, { type: 'load-started', mode: 'replace' }),
      {
        type: 'page-loaded',
        mode: 'replace',
        page: { data: [row({ id: 'user-9', username: 'operator' })], nextCursor: null },
      },
    );
    const html = renderToStaticMarkup(
      <UsersListSection
        state={state}
        actions={NOOP_ACTIONS}
        currentUserId="user-9"
        hasFilters={false}
      />,
    );
    expect(html).toContain('operator');
    expect(html).toContain('you');
  });
});
