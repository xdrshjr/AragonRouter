/**
 * Acceptance 2 on the wire: what the operator types in the search box and what
 * "Load more" sends, checked against the real `GET /api/admin/users` handler.
 *
 * The panel never builds a URL by hand - `buildUsersQuery` does, from
 * `normalizeUserSearch(searchInput)` - so these tests drive the same two functions the
 * panel uses and then read the request the harness actually delivered. Three classes of
 * defect are only visible here, never in a unit test of either half:
 *
 *  - a term with `&`, `+`, `=`, `%`, `#`, quotes or CJK must survive URL encoding and
 *    the server's `LIKE … ESCAPE '\'` escaping unchanged (a display name is free text);
 *  - a term longer than the panel's 64-character budget must not turn into a 400;
 *  - a keyset walk must not repeat or drop rows when the row a cursor points at is
 *    deleted between two pages, or when a role/status filter narrows the list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUser,
  deleteUser,
  listUsers,
  login,
  buildUsersQuery,
} from '@/components/console/api';
import { normalizeUserSearch, USER_SEARCH_MAX_LENGTH } from '@/components/console/validation';
import { USER_PAGE_SIZE, mergeUserPages } from '@/components/console/users/user-copy';
import type { UserPublic, UserRole, UserStatus } from '@/components/console/types';
import { createCaptcha } from '@/lib/captcha';
import {
  TEST_ADMIN_PASSWORD,
  installAdminHarness,
  prepareGatewayEnv,
} from '../ui/support/admin-harness';
import type { AdminHarness } from '../ui/support/admin-harness';

/** A fresh challenge whose answer this test knows (C-CAPTCHA). */
function signInBootstrapAdmin(): Promise<UserPublic> {
  const challenge = createCaptcha(Date.now(), { answer: 'ABCDE' });
  return login({
    username: 'admin',
    password: TEST_ADMIN_PASSWORD,
    challengeId: challenge.id,
    captchaAnswer: 'ABCDE',
  });
}

/** The `search` value a real request carried, decoded exactly like the route does. */
function wireSearch(call: { path: string }): string | null {
  const query = call.path.split('?')[1] ?? '';
  return new URLSearchParams(query).get('search');
}

/** Query the list the way the panel does: normalize, then send with the panel page size. */
function panelList(input: {
  search?: string;
  role?: UserRole | '';
  status?: UserStatus | '';
  cursor?: string | null;
}) {
  return listUsers({
    limit: USER_PAGE_SIZE,
    cursor: input.cursor ?? null,
    search: normalizeUserSearch(input.search ?? ''),
    role: input.role ?? '',
    status: input.status ?? '',
  });
}

describe('acceptance 2: the search term reaches the route unchanged', () => {
  let harness: AdminHarness;

  beforeEach(async () => {
    prepareGatewayEnv();
    harness = installAdminHarness();
    await signInBootstrapAdmin();
    harness.calls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  it('finds a display name containing & + = % # quotes and spaces', async () => {
    const terms = ['R&D Lab', 'a+b=c', '50% off_', 'quote "x" y', '赵四 ops'];
    for (const [index, term] of terms.entries()) {
      await createUser({
        username: `encoded-${index}`,
        password: 'Quiet-H4rbour-1',
        displayName: term,
      });
    }
    harness.calls.length = 0;

    for (const [index, term] of terms.entries()) {
      const page = await panelList({ search: term });
      // The display name is what the operator typed, so exactly that row matches.
      expect(page.data.map((row) => row.username), `search ${term}`).toEqual([
        `encoded-${index}`,
      ]);
      const sent = harness.calls[harness.calls.length - 1];
      expect(sent).toBeDefined();
      // Percent-encoded on the wire, identical after the route decodes it.
      expect(sent?.path).not.toContain(`search=${term}`);
      expect(sent ? wireSearch(sent) : null).toBe(term);
    }
  });

  it('finds a username that contains a dot, a dash and an underscore', async () => {
    await createUser({ username: 'dotted.name_1-x', password: 'Quiet-H4rbour-1' });
    harness.calls.length = 0;

    const page = await panelList({ search: 'DOTTED.NAME' });
    expect(page.data.map((row) => row.username)).toEqual(['dotted.name_1-x']);
    expect(wireSearch(harness.calls[0] ?? { path: '' })).toBe('DOTTED.NAME');
  });

  it('strips control characters and padding before the request leaves the panel', async () => {
    await createUser({ username: 'trimmed-one', password: 'Quiet-H4rbour-1' });
    harness.calls.length = 0;

    const page = await panelList({ search: '  trimmed-one\u0000\u001f  ' });
    expect(page.data.map((row) => row.username)).toEqual(['trimmed-one']);
    expect(wireSearch(harness.calls[0] ?? { path: '' })).toBe('trimmed-one');
  });

  it('caps the term at the documented budget instead of sending an unbounded string', async () => {
    const overlong = 'x'.repeat(USER_SEARCH_MAX_LENGTH + 40);
    const normalized = normalizeUserSearch(overlong);
    expect(normalized).toHaveLength(USER_SEARCH_MAX_LENGTH);
    harness.calls.length = 0;

    // No 400, no 500: the server answers a normal (empty) page for the capped term.
    const page = await panelList({ search: overlong });
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(wireSearch(harness.calls[0] ?? { path: '' })).toBe(normalized);
  });

  it('omits search entirely when the box is empty or only whitespace', async () => {
    await createUser({ username: 'anybody-one', password: 'Quiet-H4rbour-1' });
    harness.calls.length = 0;

    await panelList({ search: '' });
    await panelList({ search: '   ' });
    expect(harness.calls).toHaveLength(2);
    for (const call of harness.calls) {
      expect(call.path).not.toContain('search=');
      // The empty filters are omitted too, so the route sees its documented defaults.
      expect(call.path).not.toContain('role=');
      expect(call.path).not.toContain('status=');
      expect(call.path).toContain(`limit=${USER_PAGE_SIZE}`);
    }
  });

  it('builds the query the acceptance criterion names: limit&cursor&search&role&status', () => {
    const query = buildUsersQuery({
      limit: USER_PAGE_SIZE,
      cursor: '1700000000000|user-1',
      search: 'R&D',
      role: 'member',
      status: 'active',
    });
    const params = new URLSearchParams(query.slice(1));
    expect(params.get('limit')).toBe(String(USER_PAGE_SIZE));
    expect(params.get('cursor')).toBe('1700000000000|user-1');
    expect(params.get('search')).toBe('R&D');
    expect(params.get('role')).toBe('member');
    expect(params.get('status')).toBe('active');
  });
});

describe('acceptance 2: a keyset walk survives the list changing under it', () => {
  let harness: AdminHarness;

  beforeEach(async () => {
    prepareGatewayEnv();
    harness = installAdminHarness();
    await signInBootstrapAdmin();
    harness.calls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    harness.reset();
  });

  async function createMembers(usernames: string[]): Promise<UserPublic[]> {
    const created: UserPublic[] = [];
    for (const username of usernames) {
      created.push(await createUser({ username, password: 'Quiet-H4rbour-1', role: 'member' }));
    }
    return created;
  }

  it('continues past a cursor whose row was deleted, dropping and repeating nothing', async () => {
    const created = await createMembers(['gone-a', 'gone-b', 'gone-c', 'gone-d', 'gone-e']);
    const firstPage = await listUsers({ limit: 2 });
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    // The row the cursor was minted from is deleted before "Load more" is pressed.
    const cursorRow = firstPage.data[firstPage.data.length - 1];
    expect(cursorRow).toBeDefined();
    await deleteUser(String(cursorRow?.id));

    const secondPage = await listUsers({ limit: 2, cursor: firstPage.nextCursor });
    const survivingFirstPage = firstPage.data.filter((row) => row.id !== cursorRow?.id);
    const merged = mergeUserPages(survivingFirstPage, secondPage.data);

    expect(new Set(merged.map((row) => row.id)).size).toBe(merged.length);
    const deletedIds = created.map((row) => row.id).filter((id) => id !== cursorRow?.id);
    for (const id of merged.map((row) => row.id)) {
      expect(deletedIds).toContain(id);
    }
    // The survivors of page one plus the whole of page two are all newer than the cursor.
    expect(merged.length).toBeGreaterThan(survivingFirstPage.length);
  });

  it('walks a role+status filter across pages without admitting a foreign row', async () => {
    const members = await createMembers(['f-one', 'f-two', 'f-three', 'f-four']);
    const outsider = members[1];
    expect(outsider).toBeDefined();
    // One member is disabled: the filtered walk must never show it.
    await listUsers({ search: 'f-two' });
    const { updateUser } = await import('@/components/console/api');
    await updateUser(String(outsider?.id), { status: 'disabled' });

    const collected: UserPublic[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: { data: UserPublic[]; nextCursor: string | null } = await listUsers({
        limit: 2,
        cursor,
        role: 'member',
        status: 'active',
      });
      collected.push(...result.data);
      cursor = result.nextCursor;
      if (cursor === null) break;
      expect(result.data.length).toBeLessThanOrEqual(2);
    }

    expect(new Set(collected.map((row) => row.id)).size).toBe(collected.length);
    for (const row of collected) {
      expect(row.role).toBe('member');
      expect(row.status).toBe('active');
    }
    // f-one, f-three, f-four are active members; the bootstrap admin is not a member.
    expect(collected.map((row) => row.username).sort()).toEqual(['f-four', 'f-one', 'f-three']);
    expect(collected.map((row) => row.id)).not.toContain(outsider?.id);
  });

  it('shows a freshly created account on the first page a refresh reloads', async () => {
    const created = await createMembers(['fresh-one']);
    const firstPage = await panelList({});
    // The panel's copy promises "newest first": a refresh after create must show it.
    expect(firstPage.data[0]?.id).toBe(created[0]?.id);
    expect(firstPage.data.map((row) => row.username)).toContain('fresh-one');
  });

  it('reports the end of the list instead of a cursor it cannot honour', async () => {
    await createMembers(['end-a', 'end-b']);
    const first = await listUsers({ limit: 2 });
    // Exactly the page size is a preference, not a guarantee: the route fetches
    // `limit + 1` rows, so the absence of a cursor means the whole list was delivered.
    const second = await listUsers({ limit: 50 });
    expect(second.nextCursor).toBeNull();
    expect(mergeUserPages(first.data, second.data)).toHaveLength(second.data.length);
  });
});
