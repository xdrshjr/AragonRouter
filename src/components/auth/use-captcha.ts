'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { fetchCaptcha, isAbortError } from '@/components/console/api';
import type { CaptchaChallengePublic } from '@/components/console/types';

/**
 * Graphical captcha loader (C-CAPTCHA).
 *
 * The challenge is fetched on mount, on every explicit refresh (clicking the
 * image) and after every failed submission, because a verified challenge is
 * consumed on success and a wrong answer burns one of its five attempts.
 *
 * The state transitions are a pure reducer so they can be asserted without a DOM;
 * the hook only adds the request bookkeeping (one in-flight request, aborted when
 * a newer one starts or the component unmounts).
 */

export interface CaptchaState {
  challenge: CaptchaChallengePublic | null;
  loading: boolean;
  /** Message shown when the challenge could not be loaded at all. */
  error: string | null;
}

export type CaptchaEvent =
  | { type: 'requested' }
  | { type: 'received'; challenge: CaptchaChallengePublic }
  | { type: 'failed'; message: string };

export const initialCaptchaState: CaptchaState = { challenge: null, loading: true, error: null };

/**
 * Apply one captcha event.
 *
 * A failed refresh keeps the previous image reachable but clears it: showing a
 * challenge the server has already burned would invite a guaranteed 400.
 */
export function captchaReducer(state: CaptchaState, event: CaptchaEvent): CaptchaState {
  switch (event.type) {
    case 'requested':
      return { ...state, loading: true, error: null };
    case 'received':
      return { challenge: event.challenge, loading: false, error: null };
    case 'failed':
      return { ...state, challenge: null, loading: false, error: event.message };
    default:
      return state;
  }
}

/** Copy for a challenge that could not be loaded. */
export const CAPTCHA_LOAD_FAILED_MESSAGE =
  'The security code could not be loaded. Click the image to try again.';

export interface CaptchaController extends CaptchaState {
  /** Load a new challenge, replacing the current one. */
  refresh: () => void;
}

/**
 * Load and refresh one challenge.
 *
 * `enabled` lets a caller mount the hook while the dialog is closed and only
 * start requesting once it opens (a hidden dialog must not mint challenges).
 */
export function useCaptcha(enabled = true): CaptchaController {
  const [state, dispatch] = useReducer(captchaReducer, enabled, (active) => ({
    ...initialCaptchaState,
    loading: active,
  }));
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    dispatch({ type: 'requested' });
    fetchCaptcha(current.signal)
      .then((challenge) => {
        if (!mounted.current || current.signal.aborted) return;
        dispatch({ type: 'received', challenge });
      })
      .catch((error: unknown) => {
        if (!mounted.current || current.signal.aborted || isAbortError(error)) return;
        dispatch({ type: 'failed', message: CAPTCHA_LOAD_FAILED_MESSAGE });
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  return { ...state, refresh };
}
