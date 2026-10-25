import type { Metadata } from 'next';
import { LogsPanel } from '@/components/console/LogsPanel';

export const metadata: Metadata = {
  title: 'Logs',
};

/** `/console/logs` - filterable, cursor-paginated request log (C8). */
export default function LogsPage(): React.ReactNode {
  return <LogsPanel />;
}
