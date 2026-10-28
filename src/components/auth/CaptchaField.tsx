'use client';

import type { ReactNode, Ref } from 'react';
import { RefreshCw } from 'lucide-react';
import { Field, Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/components/ui/cn';
import { CAPTCHA_HINT, CAPTCHA_LABEL } from '@/components/auth/messages';
import { CAPTCHA_ANSWER_MAX_LENGTH } from '@/components/auth/validation';
import type { CaptchaChallengePublic } from '@/components/console/types';

/** Opaque-enough scrim that keeps the image readable while a new code loads. */
const LOADING_OVERLAY_CLASS =
  'absolute inset-0 flex items-center justify-center bg-[color:var(--overlay)] text-text';

export interface CaptchaFieldProps {
  challenge: CaptchaChallengePublic | null;
  loading: boolean;
  /** Message from the loader (challenge could not be fetched at all). */
  loadError: string | null;
  /** Fetch a new challenge - bound to the image itself and to the keyboard. */
  onRefresh: () => void;
  value: string;
  onChange: (value: string) => void;
  /** Validation or server message for this field. */
  error?: string | null;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * Graphical captcha control (C-CAPTCHA): the challenge image, a click-to-refresh
 * surface and the answer input.
 *
 * The image is a `<button>` on purpose - "click the picture for a new code" has to
 * be reachable with the keyboard - and it carries `aria-busy` while a new
 * challenge loads, so a screen reader hears that the refresh is in progress
 * instead of seeing a stale picture. The input is never prefilled and never
 * echoed back; a wrong answer only produces a message.
 */
export function CaptchaField({
  challenge,
  loading,
  loadError,
  onRefresh,
  value,
  onChange,
  error = null,
  disabled = false,
  inputRef,
}: CaptchaFieldProps): ReactNode {
  const message = error ?? loadError;

  return (
    <Field label={CAPTCHA_LABEL} error={message} hint={CAPTCHA_HINT} required>
      {({ id, describedBy }) => (
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={disabled}
            aria-label="Load a new security code"
            aria-busy={loading || undefined}
            className={cn(
              'group relative flex h-11 w-[132px] shrink-0 items-center justify-center',
              'overflow-hidden',
              'rounded-md border border-border-strong bg-surface-2',
              'transition-colors duration-150 ease-console hover:border-brand',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
              'focus-visible:outline-brand',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {challenge ? (
              // The source is a `data:image/svg+xml;base64,` document minted by the
              // server; it carries no script and is not fetched from anywhere.
              <img
                src={challenge.imageDataUrl}
                alt=""
                width={168}
                height={56}
                className="h-11 w-[132px] object-cover"
              />
            ) : (
              <span className="px-2 text-center text-[11px] leading-4 text-muted">
                {loading ? 'Loading code' : 'No code loaded'}
              </span>
            )}
            {loading ? (
              <span className={LOADING_OVERLAY_CLASS}>
                <Spinner size={16} label={null} />
                <span className="sr-only">Loading a new security code</span>
              </span>
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                'absolute bottom-0 left-0 right-0 flex items-center justify-center gap-1',
                'bg-[color:var(--overlay)] py-0.5 text-[10px] leading-3 text-text',
                'opacity-0 transition-opacity duration-150',
                'group-hover:opacity-100 group-focus-visible:opacity-100',
              )}
            >
              <RefreshCw size={10} aria-hidden="true" />
              New code
            </span>
          </button>

          <Input
            id={id}
            ref={inputRef}
            name="captchaAnswer"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={CAPTCHA_ANSWER_MAX_LENGTH}
            placeholder="5 characters"
            mono
            invalid={message !== null}
            aria-describedby={describedBy}
            disabled={disabled}
            className="h-11 uppercase tracking-[0.18em]"
          />
        </div>
      )}
    </Field>
  );
}
