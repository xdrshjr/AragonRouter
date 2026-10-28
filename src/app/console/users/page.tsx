import type { Metadata } from 'next';
import { UsersPanel } from '@/components/console/UsersPanel';

export const metadata: Metadata = {
  title: 'Users',
};

/**
 * `/console/users` - administrator account management (C-USERS-WIRE).
 *
 * The page itself is a thin wrapper: identity, permissions and every request live in
 * `UsersPanel`, which reads the auth context and refuses to mount its data area for a
 * guest or a `member`. Nothing is gated on the server here - the console shell is
 * guest-first, so a `member` who types this URL gets the shell plus the panel's
 * "administrator access required" notice instead of a redirect loop.
 */
export default function UsersPage(): React.ReactNode {
  return <UsersPanel />;
}
