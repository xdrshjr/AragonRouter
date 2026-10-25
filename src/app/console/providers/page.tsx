import type { Metadata } from 'next';
import { ProvidersPanel } from '@/components/console/ProvidersPanel';

export const metadata: Metadata = {
  title: 'Providers',
};

/** `/console/providers` - CRUD, enable toggle and connectivity test (C6). */
export default function ProvidersPage(): React.ReactNode {
  return <ProvidersPanel />;
}
