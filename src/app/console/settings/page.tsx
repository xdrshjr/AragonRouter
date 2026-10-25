import type { Metadata } from 'next';
import { SettingsPanel } from '@/components/console/SettingsPanel';

export const metadata: Metadata = {
  title: 'Settings',
};

/** `/console/settings` - read-only view of the effective configuration. */
export default function SettingsPage(): React.ReactNode {
  return <SettingsPanel />;
}
