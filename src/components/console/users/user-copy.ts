/**
 * The DOM-free decisions of the account panel: page size, debounce, labels,
 * keyset page merging and the translation of a server refusal into operator copy.
 *
 * They live apart from the components so they can be driven directly by tests
 * (`tests/ui/users-panel.test.tsx` and `tests/users-admin-ui/**`) without a DOM, and
 * so the panel and the dialogs share one definition instead of two drifting copies.
 */

import type { SelectOption } from '@/components/ui/Select';
import { ADMIN_REQUIRED_MESSAGE, ApiError, isForbidden } from '@/components/console/api';
import { describeUserRuleMessage } from '@/components/console/validation';
import {
  USER_ROLES,
  USER_STATUSES,
  type UserPublic,
  type UserRole,
  type UserStatus,
} from '@/components/console/types';

/** Keyset page size for `GET /api/admin/users` (the API default is 20, the cap 100). */
export const USER_PAGE_SIZE = 20;

/** Debounce so typing a search term does not fire one request per keystroke. */
export const USER_SEARCH_DEBOUNCE_MS = 300;

/** Copy for a list request that never reached the server, or reached it and failed. */
export const LIST_FAILURE_MESSAGE = 'The account list could not be loaded.';

const ROLE_LABELS: Readonly<Record<UserRole, string>> = { admin: 'Admin', member: 'Member' };

const STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  active: 'Active',
  disabled: 'Disabled',
};

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role];
}

export function statusLabel(status: UserStatus): string {
  return STATUS_LABELS[status];
}

/** Filter selects: the empty value means "no filter", exactly what the API expects. */
export const ROLE_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'Any role' },
  ...USER_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
];

export const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'Any status' },
  ...USER_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
];

/** Form selects: a role/status is always required, so there is no empty option. */
export const ROLE_OPTIONS: readonly SelectOption[] = USER_ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
}));

export const STATUS_OPTIONS: readonly SelectOption[] = USER_STATUSES.map((status) => ({
  value: status,
  label: STATUS_LABELS[status],
}));

/**
 * Append one keyset page of accounts, dropping ids that are already on screen.
 *
 * C-USERS-WIRE paginates on `(created_at, id)`. A row created between two requests
 * can therefore be returned twice, and a duplicate React key breaks the table - the
 * same guard `mergeLogPages` applies to the request log.
 */
export function mergeUserPages(
  existing: readonly UserPublic[],
  incoming: readonly UserPublic[],
): UserPublic[] {
  const seen = new Set(existing.map((row) => row.id));
  const merged = [...existing];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

/**
 * Operator copy for a failed account action.
 *
 * A 403 means "signed in, not an administrator"; every 400 carries the store's own
 * rule wording, which `describeUserRuleMessage` translates. Nothing is filtered out:
 * the 401 that means "session expired" is shown too, next to the dialog the shell
 * opens for it, because a button that silently does nothing is worse.
 */
export function describeUserActionFailure(error: ApiError): string {
  if (isForbidden(error)) return ADMIN_REQUIRED_MESSAGE;
  return describeUserRuleMessage(error.message);
}

/** Copy for a list request: the 403 of a `member` never leaks the raw API sentence. */
export function describeListFailure(error: ApiError): string {
  if (isForbidden(error)) return ADMIN_REQUIRED_MESSAGE;
  return error.message || LIST_FAILURE_MESSAGE;
}

/** Wrap anything the client threw into the `ApiError` shape the UI renders. */
export function toApiError(cause: unknown, fallback = LIST_FAILURE_MESSAGE): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(cause instanceof Error ? cause.message : fallback, 0, 'network');
}
