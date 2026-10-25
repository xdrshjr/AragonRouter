import type { Metadata } from 'next';
import { OverviewPanel } from '@/components/console/OverviewPanel';

export const metadata: Metadata = {
  title: 'Overview',
};

/** `/console` - KPI cards, usage chart and recent requests (C7 + C8). */
export default function ConsoleOverviewPage(): React.ReactNode {
  // The session gate lives in `layout.tsx`, so it runs before this page renders.
  return <OverviewPanel />;
}
