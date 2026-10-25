'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Zap } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { NAV_ITEMS, isActivePath } from '@/components/console/nav';

export interface SidebarProps {
  /** Rendered inside the mobile drawer: selecting a link must close it. */
  onNavigate?: () => void;
}

/**
 * Fixed navigation rail (Supabase-style: product mark on top, one flat list of
 * sections, muted labels, brand-tinted active row).
 */
export function Sidebar({ onNavigate }: SidebarProps): React.ReactNode {
  const pathname = usePathname();

  return (
    <nav aria-label="Console sections" className="flex h-full flex-col gap-6 px-3 py-4">
      <Link
        href="/console"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-md px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-on-brand">
          <Zap size={15} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold leading-5 text-text">AragonRouter</span>
          <span className="block truncate text-[11px] leading-4 text-muted">Relay console</span>
        </span>
      </Link>

      <div className="flex-1 space-y-6">
        <div>
          <p className="label-caps px-2 pb-1.5">Platform</p>
          <ul className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const active = isActivePath(pathname, item.href, item.exact);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ease-console',
                      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                      active
                        ? 'bg-surface-2 font-medium text-text'
                        : 'text-muted hover:bg-surface-2/60 hover:text-text',
                    )}
                  >
                    <Icon
                      size={15}
                      aria-hidden="true"
                      className={cn('shrink-0', active ? 'text-brand' : 'text-muted group-hover:text-text')}
                    />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="rounded-md border border-border bg-surface-2/60 px-2.5 py-2">
        <p className="label-caps">Relay</p>
        <p className="mt-1 text-[11px] leading-4 text-muted">
          Client traffic is served from <span className="mono text-text">/api/v1</span>.
        </p>
      </div>
    </nav>
  );
}
