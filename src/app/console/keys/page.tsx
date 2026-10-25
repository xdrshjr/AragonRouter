import type { Metadata } from 'next';
import { KeysPanel } from '@/components/console/KeysPanel';

export const metadata: Metadata = {
  title: 'API keys',
};

/** `/console/keys` - create, list (prefix only) and revoke client keys (C5). */
export default function KeysPage(): React.ReactNode {
  return <KeysPanel />;
}
