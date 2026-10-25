'use client';

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Button } from '@/components/ui/Button';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Footer actions, right aligned. */
  footer?: ReactNode;
  /** Width preset. */
  size?: 'sm' | 'md' | 'lg';
  /** Set while a submit is in flight: the backdrop and Escape stop closing. */
  busy?: boolean;
  /**
   * Failure message produced by the action the dialog submits. Rendered inside
   * the panel so a rejected mutation is never reported behind the overlay.
   */
  error?: string | null;
  /** Extra classes for the panel. */
  className?: string;
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
} as const;

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog.
 *
 * Responsibilities kept here (so no page reimplements them): portal rendering,
 * Escape to close, backdrop click to close, focus moved into the dialog and
 * restored on close, Tab cycling trapped inside the panel, and page scroll lock.
 * `busy` freezes dismissal so a half-finished mutation cannot be interrupted.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  busy = false,
  error = null,
  className,
}: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const requestClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  // Move focus in on open, restore it on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Lock page scrolling while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Escape to close, Tab to cycle inside the panel.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, requestClose]);

  if (!open) return null;
  // `document` is unavailable during the server render; the portal waits for mount.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        aria-hidden="true"
        onClick={requestClose}
        className="fixed inset-0 bg-[color:var(--overlay)] backdrop-blur-[2px] animate-fade-in"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 my-auto w-full rounded-card border border-border bg-surface shadow-pop animate-scale-in',
          SIZES[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold leading-6 text-text">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-xs leading-5 text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={requestClose}
            disabled={busy}
            aria-label="Close dialog"
            className="-mr-1 -mt-1"
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        <div className="px-4 py-4">{children}</div>
        {error ? (
          <div className="border-t border-border px-4 py-2">
            <p role="alert" className="break-words text-xs leading-5 text-danger">
              {error}
            </p>
          </div>
        ) : null}
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button in the danger style (destructive actions). */
  destructive?: boolean;
  busy?: boolean;
  /** Failure message of the attempted action, rendered inside the dialog. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Two-button confirmation used before every destructive console action. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      busy={busy}
      error={error}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            loading={busy}
            loadingLabel="Working"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-6 text-muted">{description}</div>
    </Modal>
  );
}
