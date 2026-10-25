'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/components/ui/cn';

/**
 * Copy text to the clipboard without assuming a secure context.
 *
 * `navigator.clipboard` only exists on HTTPS/localhost; an operator on a LAN
 * address falls back to a hidden textarea plus `document.execCommand('copy')`.
 * Both paths can fail (permissions), so the caller always receives a boolean and
 * the button reports the outcome instead of silently doing nothing.
 */
export async function copyText(value: string): Promise<boolean> {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  if (typeof document === 'undefined') return false;
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export interface CopyButtonProps {
  value: string;
  /** Visible label; omitted for an icon-only button. */
  label?: string;
  /** Accessible name; required when `label` is omitted. */
  ariaLabel?: string;
  size?: 'sm' | 'md';
  className?: string;
  onResult?: (ok: boolean) => void;
}

/** Copy affordance with a transient "copied" state. */
export function CopyButton({ value, label, ariaLabel, size = 'sm', className, onResult }: CopyButtonProps): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const onClick = useCallback(async () => {
    const ok = await copyText(value);
    onResult?.(ok);
    if (!ok) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
    }, 1600);
  }, [onResult, value]);

  return (
    <button
      type="button"
      onClick={() => {
        void onClick();
      }}
      aria-label={ariaLabel ?? label ?? 'Copy to clipboard'}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface-2 font-medium text-text',
        'transition-colors duration-150 ease-console hover:border-text-muted',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm',
        className,
      )}
    >
      {copied ? (
        <Check size={13} aria-hidden="true" className="text-brand" />
      ) : (
        <Copy size={13} aria-hidden="true" />
      )}
      {label ? <span>{copied ? 'Copied' : label}</span> : null}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}
