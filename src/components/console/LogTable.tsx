'use client';

import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableMessage, TableRow } from '@/components/ui/Table';
import { formatDateTimeShort, formatLatency, formatTokens, statusTone, truncateEnd } from '@/components/console/format';
import type { RequestLogPublic } from '@/components/console/types';

export interface LogTableProps {
  rows: readonly RequestLogPublic[];
  /** `compact` hides the path/upstream columns for the overview card. */
  variant?: 'full' | 'compact';
  /** Message rendered when `rows` is empty. */
  emptyMessage?: string;
  /** Optional trailing column (logs page uses it for row details). */
  renderActions?: (row: RequestLogPublic) => ReactNode;
  /** Highlight rows that failed. */
  emphasisErrors?: boolean;
}

/**
 * Request log table shared by the overview card and the logs page (C8 rows).
 *
 * A failed row shows its `error` as the cell tooltip and gets a danger-tinted
 * status badge, so an operator can scan for problems without opening anything.
 */
export function LogTable({
  rows,
  variant = 'full',
  emptyMessage = 'No requests match the current filters.',
  renderActions,
  emphasisErrors = true,
}: LogTableProps): ReactNode {
  const compact = variant === 'compact';
  const columnCount = (compact ? 6 : 8) + (renderActions ? 1 : 0);

  return (
    <Table minWidth={compact ? 640 : 960} caption="Request log">
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Model</TableHead>
          {compact ? null : <TableHead>Path</TableHead>}
          {compact ? null : <TableHead>Protocol</TableHead>}
          <TableHead align="right">Latency</TableHead>
          <TableHead align="right">Tokens</TableHead>
          <TableHead>Key</TableHead>
          {renderActions ? <TableHead align="right">Details</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableMessage colSpan={columnCount}>{emptyMessage}</TableMessage>
        ) : (
          rows.map((row) => {
            const failed = row.status >= 400 || row.error !== null;
            return (
              <TableRow key={row.id} hover>
                <TableCell className="whitespace-nowrap text-muted" title={row.createdAt}>
                  {formatDateTimeShort(row.createdAt)}
                </TableCell>
                <TableCell>
                  <Badge
                    tone={statusTone(row.status)}
                    mono
                    className={emphasisErrors && failed ? 'font-semibold' : undefined}
                    title={row.error ?? undefined}
                  >
                    {row.status}
                  </Badge>
                  {row.stream ? (
                    <Badge tone="info" className="ml-1" title="Server-sent events were streamed">
                      SSE
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="mono text-xs text-text" title={row.model ?? undefined}>
                    {row.model ? truncateEnd(row.model, 32) : '—'}
                  </span>
                </TableCell>
                {compact ? null : (
                  <TableCell className="whitespace-nowrap">
                    <span className="mono text-xs text-muted" title={row.upstream ? `${row.path} to ${row.upstream}` : row.path}>
                      {truncateEnd(row.path, 40)}
                    </span>
                  </TableCell>
                )}
                {compact ? null : (
                  <TableCell>
                    <span className="text-xs text-muted">{row.protocol}</span>
                  </TableCell>
                )}
                <TableCell align="right" numeric className="whitespace-nowrap text-muted">
                  {formatLatency(row.latencyMs)}
                </TableCell>
                <TableCell align="right" numeric className="whitespace-nowrap text-muted">
                  <span title={`input ${row.inputTokens ?? 0} / output ${row.outputTokens ?? 0}`}>
                    {formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="mono text-[11px] text-muted" title={row.apiKeyId ?? undefined}>
                    {row.apiKeyId ? truncateEnd(row.apiKeyId, 12) : '—'}
                  </span>
                </TableCell>
                {renderActions ? <TableCell align="right">{renderActions(row)}</TableCell> : null}
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

/** Detail block shown inside the log details dialog. */
export function LogDetailList({ row }: { row: RequestLogPublic }): ReactNode {
  const entries: readonly [string, ReactNode][] = [
    ['Request id', <span key="id" className="mono text-xs">{row.id}</span>],
    ['Received', formatDateTimeShort(row.createdAt)],
    ['Protocol', row.protocol],
    ['Path', <span key="path" className="mono text-xs">{row.path}</span>],
    ['Upstream', row.upstream ? <span key="up" className="mono text-xs">{row.upstream}</span> : '—'],
    ['Model', row.model ?? '—'],
    ['Status', <Badge key="status" tone={statusTone(row.status)} mono>{row.status}</Badge>],
    ['Latency', formatLatency(row.latencyMs)],
    ['Input tokens', row.inputTokens === null ? '—' : String(row.inputTokens)],
    ['Output tokens', row.outputTokens === null ? '—' : String(row.outputTokens)],
    ['Streamed', row.stream ? 'Yes (SSE)' : 'No'],
    ['API key', row.apiKeyId ?? '—'],
    ['Error', row.error ?? '—'],
  ];

  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-xs">
      {entries.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="label-caps">{label}</dt>
          <dd className="break-words text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
