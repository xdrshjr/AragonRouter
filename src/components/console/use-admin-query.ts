'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '@/components/console/api';

export interface AdminQueryState<T> {
  data: T | null;
  /** True only for the very first load, so a refresh does not blank the panel. */
  loading: boolean;
  /** True while any load (initial or refresh) is in flight. */
  fetching: boolean;
  error: ApiError | null;
  /** Reload with the same key. */
  refresh: () => void;
}

/**
 * Load one admin resource and keep it in sync with a key (range, filter, ...).
 *
 * Behaviour that would otherwise be repeated in every page:
 *   - the previous request is aborted when the key changes or the component
 *     unmounts, so a slow response can never overwrite a newer one;
 *   - `loading` is only true for the first load; later loads set `fetching`, so
 *     the table stays visible while a new range is fetched;
 *   - a stale response (older request resolving after a newer one) is dropped.
 */
export function useAdminQuery<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AdminQueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(true);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const requestId = useRef(0);
  const loadedOnce = useRef(false);

  const refresh = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    requestId.current += 1;
    const id = requestId.current;
    setFetching(true);
    if (!loadedOnce.current) setLoading(true);

    loaderRef
      .current(controller.signal)
      .then((result) => {
        if (id !== requestId.current) return;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (id !== requestId.current) return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(
                cause instanceof Error ? cause.message : 'The request failed unexpectedly.',
                0,
                'network',
              ),
        );
      })
      .finally(() => {
        if (id !== requestId.current) return;
        loadedOnce.current = true;
        setLoading(false);
        setFetching(false);
      });

    return () => {
      controller.abort();
    };
    // The dependency list is the caller's cache key by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, fetching, error, refresh };
}

/**
 * Track a one-shot async action (create, revoke, test): `pending` for the button,
 * and a settled error the caller can render inline.
 */
export function useAsyncAction(): {
  pending: boolean;
  error: ApiError | null;
  run: <R>(action: () => Promise<R>) => Promise<R | null>;
  reset: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async <R,>(action: () => Promise<R>): Promise<R | null> => {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      return result;
    } catch (cause) {
      if (isAbortError(cause)) return null;
      const apiError =
        cause instanceof ApiError
          ? cause
          : new ApiError(
              cause instanceof Error ? cause.message : 'The action failed unexpectedly.',
              0,
              'network',
            );
      if (mounted.current) setError(apiError);
      return null;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
  }, []);

  return { pending, error, run, reset };
}
