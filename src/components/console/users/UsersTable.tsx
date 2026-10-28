'use client';

import type { ReactNode } from 'react';
import { KeyRound, Trash2, UserCog, Users } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableMessage,
  TableRow,
} from '@/components/ui/Table';
import { formatDateTime, formatRelativeTime } from '@/components/console/format';
import type { UserPublic } from '@/components/console/types';
import { roleLabel, statusLabel } from '@/components/console/users/user-copy';

export interface UsersTableProps {
  rows: readonly UserPublic[];
  /** The signed-in administrator, so their own row can be labelled. */
  currentUserId: string | null;
  onEdit: (row: UserPublic) => void;
  onResetPassword: (row: UserPublic) => void;
  onDelete: (row: UserPublic) => void;
}

/**
 * The account table.
 *
 * Presentational on purpose: it owns no request and no state, so both the live panel
 * and `tests/ui/users-panel.test.tsx` render the same markup, and a row
 * button can only ever call back into the panel that decided what the click means.
 */
export function UsersTable({
  rows,
  currentUserId,
  onEdit,
  onResetPassword,
  onDelete,
}: UsersTableProps): ReactNode {
  return (
    <Table minWidth={920} caption="Console accounts">
      <TableHeader>
        <TableRow>
          <TableHead>Username</TableHead>
          <TableHead>Display name</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last sign-in</TableHead>
          <TableHead>Created</TableHead>
          <TableHead align="right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableMessage colSpan={7}>
            <EmptyState
              compact
              icon={<Users size={18} aria-hidden="true" />}
              title="No accounts match this view"
              description="Clear the filters, or create an account to let somebody else sign in."
            />
          </TableMessage>
        ) : (
          rows.map((row) => (
            <UserRow
              key={row.id}
              row={row}
              isSelf={currentUserId !== null && row.id === currentUserId}
              onEdit={onEdit}
              onResetPassword={onResetPassword}
              onDelete={onDelete}
            />
          ))
        )}
      </TableBody>
    </Table>
  );
}

interface UserRowProps {
  row: UserPublic;
  isSelf: boolean;
  onEdit: (row: UserPublic) => void;
  onResetPassword: (row: UserPublic) => void;
  onDelete: (row: UserPublic) => void;
}

function UserRow({ row, isSelf, onEdit, onResetPassword, onDelete }: UserRowProps): ReactNode {
  return (
    <TableRow hover>
      <TableCell className="max-w-[14rem]">
        <span className="flex items-center gap-1.5">
          <span className="mono truncate text-xs text-text" title={row.username}>
            {row.username}
          </span>
          {isSelf ? <Badge tone="info">you</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="max-w-[14rem]">
        {row.displayName ? (
          <span className="block truncate text-text" title={row.displayName}>
            {row.displayName}
          </span>
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </TableCell>
      <TableCell>
        <Badge tone={row.role === 'admin' ? 'brand' : 'neutral'}>{roleLabel(row.role)}</Badge>
      </TableCell>
      <TableCell>
        <Badge tone={row.status === 'active' ? 'success' : 'danger'} dot>
          {statusLabel(row.status)}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted" title={row.lastLoginAt ?? undefined}>
        {row.lastLoginAt ? formatRelativeTime(row.lastLoginAt) : 'never'}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted" title={row.createdAt}>
        {formatDateTime(row.createdAt)}
      </TableCell>
      <TableCell align="right">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${row.username}`}
            leftIcon={<UserCog size={13} aria-hidden="true" />}
            onClick={() => onEdit(row)}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Reset the password of ${row.username}`}
            leftIcon={<KeyRound size={13} aria-hidden="true" />}
            onClick={() => onResetPassword(row)}
          >
            Reset
          </Button>
          <Button
            variant="danger"
            size="sm"
            aria-label={`Delete ${row.username}`}
            leftIcon={<Trash2 size={13} aria-hidden="true" />}
            onClick={() => onDelete(row)}
          >
            Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
