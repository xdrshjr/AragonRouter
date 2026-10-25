'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import type { ToastTone } from '@/components/console/types';

export interface ToastInput {
  /** Short headline, e.g. "Key created". */
  title: string;
  /** Optional detail line (server messages are already truncated by the API client). */
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss; `0` keeps the toast until dismissed. */
  durationMs?: number;
}

interface ToastRecord extends Required<Omit<ToastInput, 'description'>> {
  id: number;
  description?: string;
}

interface ToastApi {
  push: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION_MS = 5000;
const MAX_VISIBLE = 4;

const TONE_STYLES: Record<ToastTone, string> = {
  success: 'border-brand/50',
  danger: 'border-danger/50',
  warning: 'border-warning/50',
  info: 'border-info/50',
};

const TONE_ICON: Record<ToastTone, ReactNode> = {
  success: <CheckCircle2 size={16} className="text-brand" aria-hidden="true" />,
  danger: <XCircle size={16} className="text-danger" aria-hidden="true" />,
  warning: <TriangleAlert size={16} className="text-warning" aria-hidden="true" />,
  info: <Info size={16} className="text-info" aria-hidden="true" />,
};

/**
 * Toast host. Mounted once by the console shell, so any page can report the
 * outcome of a mutation without owning layout space for it.
 *
 * Toasts are announced through `aria-live`: errors use `assertive`, everything
 * else `polite`.
 */
export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current;
      nextId.current += 1;
      const record: ToastRecord = {
        id,
        title: input.title,
        description: input.description,
        tone: input.tone ?? 'info',
        durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
      };
      setToasts((current) => {
        const next = [...current, record];
        // Keep the newest; an operator does not need a wall of history.
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      if (record.durationMs > 0) {
        const timer = setTimeout(() => {
          timers.current.delete(id);
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }, record.durationMs);
        timers.current.set(id, timer);
      }
      return id;
    },
    [],
  );

  // Never leave timers behind on unmount (React strict mode remounts in dev).
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,360px)] flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'danger' ? 'alert' : 'status'}
            aria-live={toast.tone === 'danger' ? 'assertive' : 'polite'}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-card border bg-surface px-3 py-2.5 shadow-pop animate-slide-in-right',
              TONE_STYLES[toast.tone],
            )}
          >
            <span className="mt-0.5 shrink-0">{TONE_ICON[toast.tone]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-5 text-text">{toast.title}</p>
              {toast.description ? (
                <p className="mt-0.5 break-words text-xs leading-5 text-muted">{toast.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                dismiss(toast.id);
              }}
              aria-label="Dismiss notification"
              className="-mr-1 -mt-1 rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Access the toast API. Returns a no-op implementation when no provider is
 * mounted, so a component can be rendered (or unit-rendered) in isolation.
 */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (context) return context;
  return {
    push: () => 0,
    dismiss: () => {
      /* no provider mounted */
    },
  };
}
