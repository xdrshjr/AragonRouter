'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FilterX, ScrollText, Search } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardTitle } from '@/components/ui/Card';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { LogDetailList, LogTable } from '@/components/console/LogTable';
import { useSessionExpiryRedirect } from '@/components/console/AuthGuard';
import {
  ApiError,
  isAbortError,
  isUnauthorized,
  listLogs,
} from '@/components/console/api';
import {
  LOG_PAGE_SIZE,
  STATUS_FILTER_OPTIONS,
  buildLogsQuery,
  mergeLogPages,
  normalizeModelFilter,
  normalizeStatusFilter,
} from '@/components/console/log-query';
import { formatNumber } from '@/components/console/format';
import type { LogFilters, RequestLogPublic } from '@/components/console/types';

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  ...STATUS_FILTER_OPTIONS.map((status) => ({ value: status, label: status })),
];

/** Debounce so typing a model name does not fire one request per keystroke. */
const MODEL_DEBOUNCE_MS = 350;

type LoadMode = 'replace' | 'append';

/**
 * `/console/logs` (C8).
 *
 * Filters (`status` exact match, `model` exact match) plus keyset pagination:
 * "Load more" sends the `nextCursor` returned by the previous page and appends the
 * rows, de-duplicating ids in case a concurrent write shifted the window.
 */
export function LogsPanel(): ReactNode {
  const [status, setStatus] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [model, setModel] = useState('');
  const [rows, setRows] = useState<RequestLogPublic[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [detail, setDetail] = useState<RequestLogPublic | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const requestId = useRef(0);
  const mounted = useRef(true);

  useSessionExpiryRedirect(error);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Debounce the model filter.
  useEffect(() => {
    const trimmed = normalizeModelFilter(modelInput);
    if (trimmed === model) return;
    const timer = setTimeout(() => {
      setModel(trimmed);
    }, MODEL_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [model, modelInput]);

  const filters = useMemo<LogFilters>(() => ({ status, model }), [status, model]);

  const load = useCallback(
    async (mode: LoadMode, cursor: string | null, signal: AbortSignal) => {
      requestId.current += 1;
      const id = requestId.current;
      if (mode === 'replace') {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        const page = await listLogs(
          {
            limit: LOG_PAGE_SIZE,
            cursor: mode === 'append' ? cursor : null,
            status: normalizeStatusFilter(filters.status),
            model: normalizeModelFilter(filters.model),
          },
          signal,
        );
        if (!mounted.current || id !== requestId.current) return;
        setRows((current) => (mode === 'append' ? mergeLogPages(current, page.data) : page.data));
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (signal.aborted || isAbortError(cause)) return;
        if (!mounted.current || id !== requestId.current) return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(
                cause instanceof Error ? cause.message : 'The request log could not be loaded.',
                0,
                'network',
              ),
        );
        if (mode === 'replace') {
          setRows([]);
          setNextCursor(null);
        }
      } finally {
        if (mounted.current && id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filters],
  );

  // Reset to the first page whenever the filters (or the manual reload) change.
  useEffect(() => {
    const controller = new AbortController();
    void load('replace', null, controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, reloadToken]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore || loading) return;
    const controller = new AbortController();
    void load('append', nextCursor, controller.signal);
  }, [load, loading, loadingMore, nextCursor]);

  const resetFilters = useCallback(() => {
    setStatus('');
    setModelInput('');
    setModel('');
  }, []);

  const hasFilters = status.length > 0 || model.length > 0 || modelInput.length > 0;
  const firstPageEmpty = rows.length === 0;
  const errorIsAuth = error !== null && isUnauthorized(error);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-caps">Logs</p>
          <h2 className="mt-1 text-xl font-semibold leading-7 text-text">Request history</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Newest first. Filters match exactly; pagination follows{' '}
            <span className="mono text-text">&lt;created_at&gt;|&lt;id&gt;</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="neutral" mono>
            {formatNumber(rows.length)} loaded
          </Badge>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setReloadToken((token) => token + 1);
            }}
            loading={loading}
            loadingLabel="Refreshing"
          >
            Refresh
          </Button>
        </div>
      </div>

      <Card className="p-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setModel(normalizeModelFilter(modelInput));
            setReloadToken((token) => token + 1);
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="w-36">
            <Field label="Status" caps>
              {({ id }) => (
                <Select
                  id={id}
                  options={STATUS_OPTIONS}
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                  }}
                  aria-label="Filter by HTTP status"
                />
              )}
            </Field>
          </div>
          <div className="min-w-[14rem] flex-1">
            <Field label="Model" caps>
              {({ id }) => (
                <Input
                  id={id}
                  value={modelInput}
                  onChange={(event) => {
                    setModelInput(event.target.value);
                  }}
                  placeholder="exact model id, e.g. claude-sonnet-4-5"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Filter by model"
                  mono
                  leading={<Search size={13} aria-hidden="true" />}
                  trailing={
                    modelInput.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setModelInput('');
                          setModel('');
                        }}
                        aria-label="Clear the model filter"
                        className="mr-0.5 rounded p-1 text-muted hover:bg-surface hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                      >
                        <FilterX size={13} aria-hidden="true" />
                      </button>
                    ) : null
                  }
                />
              )}
            </Field>
          </div>
          <div className="flex items-center gap-2 pb-0.5">
            <Button type="submit" variant="secondary" size="sm" loading={loading} loadingLabel="Applying">
              Apply
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              disabled={!hasFilters}
            >
              Reset
            </Button>
          </div>
        </form>
      </Card>

      <Card flush className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4">
          <CardTitle
            eyebrow="Entries"
            description={
              hasFilters
                ? `Filtered by ${[status ? `status ${status}` : null, model ? `model ${model}` : null]
                    .filter(Boolean)
                    .join(' and ')}.`
                : 'Every proxied request, including failures and streamed responses.'
            }
          >
            Request log
          </CardTitle>
        </div>

        {error && !errorIsAuth ? (
          <div className="p-4">
            <ErrorState
              title="The request log is unavailable"
              message={error.message}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setReloadToken((token) => token + 1);
                  }}
                >
                  Try again
                </Button>
              }
            />
          </div>
        ) : loading ? (
          <LoadingBlock label="Loading requests" />
        ) : firstPageEmpty ? (
          <EmptyState
            icon={<ScrollText size={18} aria-hidden="true" />}
            title={hasFilters ? 'No requests match these filters' : 'No requests logged yet'}
            description={
              hasFilters
                ? 'Clear the filters or try a different status or model id.'
                : 'Once a client calls /api/v1/messages the entry appears here within a second.'
            }
            action={
              hasFilters ? (
                <Button size="sm" variant="secondary" onClick={resetFilters}>
                  Clear filters
                </Button>
              ) : null
            }
          />
        ) : (
          <LogTable
            rows={rows}
            renderActions={(row) => (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDetail(row);
                }}
              >
                View
              </Button>
            )}
          />
        )}

        {!firstPageEmpty && !loading ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
            <p className="text-[11px] leading-4 text-muted">
              {nextCursor ? 'More entries are available.' : 'You have reached the end of the log.'}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={loadMore}
              disabled={nextCursor === null}
              loading={loadingMore}
              loadingLabel="Loading"
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Card>

      <p className="text-[11px] leading-4 text-muted">
        Query sent to the API: <span className="mono text-text">/api/admin/logs{buildLogsQuery({ limit: LOG_PAGE_SIZE, status, model })}</span>
      </p>

      <Modal
        open={detail !== null}
        onClose={() => {
          setDetail(null);
        }}
        title="Request details"
        description="One row from request_logs. Errors are recorded exactly as the upstream or relay reported them."
        size="lg"
        footer={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setDetail(null);
            }}
          >
            Close
          </Button>
        }
      >
        {detail ? <LogDetailList row={detail} /> : null}
      </Modal>
    </div>
  );
}
