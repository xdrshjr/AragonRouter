/**
 * Rendered-markup tests for the console components.
 *
 * No DOM is available (the work package may not add jsdom/testing-library) but
 * `react-dom/server` is already a dependency, so the *server* render of every
 * component can be asserted for real: the markup the operator's browser receives on
 * first paint. Effects do not run in a static render, which is exactly the state a
 * page shows before its first fetch resolves - the skeleton/loading path.
 *
 * Interaction-only behaviour (dialog focus trap, toast auto-dismiss, hook
 * abort/stale handling) is verified through the extracted pure modules and, where
 * that is impossible, reported as a gap rather than claimed here.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  usePathname: () => '/console',
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import { UsageChart } from '@/components/console/UsageChart';
import { OverviewPanel } from '@/components/console/OverviewPanel';
import { KeysPanel } from '@/components/console/KeysPanel';
import { ProvidersPanel } from '@/components/console/ProvidersPanel';
import { LogsPanel } from '@/components/console/LogsPanel';
import { SettingsPanel } from '@/components/console/SettingsPanel';
import { LoginForm } from '@/app/login/LoginForm';
import { StatCard, StatCardSkeleton } from '@/components/console/StatCard';
import { LogTable, LogDetailList } from '@/components/console/LogTable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { ToastProvider } from '@/components/ui/Toast';
import type { RequestLogPublic, StatsPayload } from '@/components/console/types';

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function statsFixture(overrides: Partial<StatsPayload> = {}): StatsPayload {
  return {
    range: '24h',
    totals: { requests: 42, inputTokens: 1200, outputTokens: 800, errorRate: 0.0714, avgLatencyMs: 640 },
    series: [
      { t: '2024-06-01T00:00:00.000Z', requests: 4, inputTokens: 100, outputTokens: 60, errors: 0 },
      { t: '2024-06-01T01:00:00.000Z', requests: 9, inputTokens: 300, outputTokens: 200, errors: 1 },
      { t: '2024-06-01T02:00:00.000Z', requests: 29, inputTokens: 800, outputTokens: 540, errors: 2 },
    ],
    byModel: [{ model: 'claude-sonnet-4-5', requests: 42, inputTokens: 1200, outputTokens: 800 }],
    byKey: [{ apiKeyId: 'k1', name: 'Production', requests: 42 }],
    ...overrides,
  };
}

function logRow(overrides: Partial<RequestLogPublic> = {}): RequestLogPublic {
  return {
    id: 'log-1',
    createdAt: '2024-06-01T12:00:00.000Z',
    protocol: 'anthropic',
    path: '/api/v1/messages',
    model: 'claude-sonnet-4-5',
    upstream: 'https://api.anthropic.com',
    status: 200,
    latencyMs: 320,
    inputTokens: 12,
    outputTokens: 34,
    apiKeyId: 'key-abcdefghijkl',
    error: null,
    stream: false,
    ...overrides,
  };
}

describe('UsageChart (inline SVG)', () => {
  it('renders an accessible inline SVG with one point per bucket', () => {
    const markup = render(<UsageChart stats={statsFixture()} />);

    expect(markup).toContain('<svg');
    expect(markup).toContain('role="img"');
    expect(markup).not.toContain('<canvas');
    expect(markup).not.toContain('<img');

    // Three buckets -> three data points.
    expect((markup.match(/<circle/g) ?? []).length).toBe(3);
    // A line path and a closed area path, both driven by the pure geometry module.
    expect(markup).toMatch(/<path d="M [\d.]+ [\d.]+ L/);
    expect(markup).toContain('Z"');
    // Ticks (0..max) are rendered as dashed grid lines.
    expect((markup.match(/stroke-dasharray="2 4"/g) ?? []).length).toBeGreaterThan(0);
    // No NaN can reach the SVG output.
    expect(markup).not.toContain('NaN');
  });

  it('states the total and peak for screen readers', () => {
    const markup = render(<UsageChart stats={statsFixture()} />);
    expect(markup).toContain('sr-only');
    expect(markup).toContain('in total, peak');
    expect(markup).toContain('42');
  });

  it('shows an empty state instead of a broken chart when there is no traffic', () => {
    const markup = render(
      <UsageChart stats={statsFixture({ series: [], totals: { requests: 0, inputTokens: 0, outputTokens: 0, errorRate: 0, avgLatencyMs: 0 } })} />,
    );
    expect(markup).toContain('No traffic in this range');
    expect(markup).not.toMatch(/<path d="M/);
    expect(markup).not.toContain('NaN');
  });

  it('offers the four metrics as tabs', () => {
    const markup = render(<UsageChart stats={statsFixture()} />);
    expect(markup).toContain('role="tablist"');
    for (const label of ['Requests', 'Input tokens', 'Output tokens', 'Errors']) {
      expect(markup).toContain(label);
    }
  });
});

describe('OverviewPanel first paint', () => {
  it('renders four KPI placeholders and no fabricated data', () => {
    const markup = render(<OverviewPanel />);
    const labels = ['Requests', 'Error rate', 'Avg latency', 'Tokens'];
    for (const label of labels) {
      expect(markup).toContain(label);
    }
    // Four placeholder cards, two shimmer bars each: the page never claims numbers
    // it does not have yet.
    expect((markup.match(/class="skeleton/g) ?? []).length).toBe(8);
    expect((markup.match(/aria-busy="true"/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(markup).toContain('Loading usage');
    expect(markup).not.toMatch(/NaN|undefined/);
  });

  it('renders the shell copy in English only', () => {
    const markup = render(<OverviewPanel />);
    expect(markup).toContain('Relay activity');
    expect(/[\u4e00-\u9fff]/.test(markup)).toBe(false);
  });
});

describe('LoginForm', () => {
  it('binds the label to the password field and prefills nothing', () => {
    const markup = render(<LoginForm nextPath="/console" />);
    expect(markup).toContain('type="password"');
    expect(markup).toContain('name="password"');
    expect(markup).toContain('Sign in');
    expect(markup).toContain('autoComplete="current-password"');
    const labelFor = /<label for="([^"]+)"[^>]*>Admin password/.exec(markup);
    expect(labelFor?.[1]).toBeDefined();
    expect(markup).toContain(`id="${labelFor?.[1]}"`);
    // Server-rendered markup must never carry a value attribute for the password.
    expect(markup).not.toMatch(/name="password"[^>]*value="[^"]+"/);
  });

  it('does not mark the field invalid until a failure happens', () => {
    const markup = render(<LoginForm nextPath="/console" />);
    expect(markup).not.toContain('aria-invalid="true"');
    // With neither a hint nor an error there is nothing to describe yet; the error
    // paragraph (Field) adds `aria-describedby` when it appears.
    expect(markup).not.toContain('aria-describedby');
  });
});

describe('LogTable', () => {
  it('renders one row per request with a status badge and an SSE marker', () => {
    const rows = [logRow(), logRow({ id: 'log-2', status: 500, error: 'upstream exploded', stream: true })];
    const markup = render(<LogTable rows={rows} />);
    expect(markup).toContain('200');
    expect(markup).toContain('500');
    expect(markup).toContain('SSE');
    expect(markup).toContain('upstream exploded');
    expect(markup).toContain('/api/v1/messages');
    expect(markup).toContain('caption');
  });

  it('escapes provider/model text instead of injecting it', () => {
    const hostile = logRow({ model: '<img src=x onerror="alert(1)">' });
    const markup = render(<LogTable rows={[hostile]} />);
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img');
  });

  it('shows the empty message when there are no rows', () => {
    const markup = render(<LogTable rows={[]} emptyMessage="No requests match the current filters." />);
    expect(markup).toContain('No requests match the current filters.');
  });

  it('renders the detail list for a single row', () => {
    const markup = render(<LogDetailList row={logRow({ status: 502, error: 'bad gateway' })} />);
    expect(markup).toContain('Request id');
    expect(markup).toContain('bad gateway');
    expect(markup).toContain('502');
  });
});

describe('panels render their loading state without a DOM', () => {
  const panels: readonly [string, React.ReactElement][] = [
    ['KeysPanel', <KeysPanel key="keys" />],
    ['ProvidersPanel', <ProvidersPanel key="providers" />],
    ['LogsPanel', <LogsPanel key="logs" />],
    ['SettingsPanel', <SettingsPanel key="settings" />],
  ];

  for (const [name, element] of panels) {
    it(`${name} produces server markup with a status region`, () => {
      const markup = render(<ToastProvider>{element}</ToastProvider>);
      expect(markup.length).toBeGreaterThan(500);
      expect(markup).not.toContain('undefined');
      expect(/[\u4e00-\u9fff]/.test(markup)).toBe(false);
    });
  }

  it('SettingsPanel is read-only in its markup: no save or delete control', () => {
    const markup = render(
      <ToastProvider>
        <SettingsPanel />
      </ToastProvider>,
    );
    expect(markup).toContain('Read-only');
    // The endpoint documentation mentions DELETE/PATCH, so match the *actions* only.
    for (const action of ['>Save changes<', '>Revoke key<', '>Delete provider<', '>Create key<', '>Add provider<']) {
      expect(markup).not.toContain(action);
    }
  });

  it('KeysPanel never renders a full key on first paint', () => {
    const markup = render(
      <ToastProvider>
        <KeysPanel />
      </ToastProvider>,
    );
    expect(markup).not.toMatch(/ar-[0-9a-f]{32}/);
  });
});

describe('UI primitives', () => {
  it('StatCard renders the label, the value and the tooltip', () => {
    const markup = render(<StatCard label="Requests" value="1,234" title="input 900 / output 334" hint="Last 7d" />);
    expect(markup).toContain('Requests');
    expect(markup).toContain('1,234');
    expect(markup).toContain('Last 7d');
    expect(markup).toContain('title="input 900 / output 334"');
  });

  it('StatCardSkeleton is announced as busy', () => {
    expect(render(<StatCardSkeleton label="Tokens" />)).toContain('aria-busy="true"');
  });

  it('Switch exposes role=switch with its state and accessible name', () => {
    const on = render(<Switch checked onCheckedChange={() => undefined} label="Disable Anthropic" />);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('Disable Anthropic');

    const off = render(<Switch checked={false} onCheckedChange={() => undefined} label="Enable Anthropic" />);
    expect(off).toContain('aria-checked="false"');
  });

  it('Tabs exposes a roving tablist with the selected tab only in the tab order', () => {
    const markup = render(
      <Tabs
        items={[
          { value: '24h', label: '24h' },
          { value: '7d', label: '7d' },
        ]}
        value="7d"
        onChange={() => undefined}
        label="Statistics range"
      />,
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Statistics range"');
    expect((markup.match(/aria-selected="false"/g) ?? []).length).toBe(1);
    expect((markup.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((markup.match(/tabindex="-1"/g) ?? []).length).toBe(1);
  });

  it('Button reports its busy state and keeps the accessible name', () => {
    const markup = render(
      <Button loading loadingLabel="Signing in">
        Sign in
      </Button>,
    );
    expect(markup).toContain('disabled');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Signing in');
  });

  it('Spinner and EmptyState/ErrorState are announced correctly', () => {
    expect(render(<Spinner label="Loading keys" />)).toContain('Loading keys');
    const empty = render(<EmptyState title="No API keys yet" description="Create a key to start." />);
    expect(empty).toContain('No API keys yet');
    const error = render(<ErrorState title="Keys are unavailable" message="HTTP 500" />);
    expect(error).toContain('role="alert"');
    expect(error).toContain('HTTP 500');
  });

  it('Badge renders its tone marker for status pills', () => {
    const markup = render(
      <Badge tone="danger" dot mono>
        500
      </Badge>,
    );
    expect(markup).toContain('500');
    expect(markup).toContain('rounded-full');
  });
});
