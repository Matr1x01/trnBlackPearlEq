import { useCallback, useEffect, useRef, useState } from "react";
import "./Toast.css";

/**
 * Minimal transient notifications.
 *
 * Written rather than pulled in: the app has two dependencies (react and
 * react-dom) and one long-lived error banner in App.tsx, and a toast stack is
 * a list plus a timer. A library would be more code shipped than written.
 *
 * The banner stays for what it is good at -- persistent, dismiss-on-click
 * failures. Toasts are for the outcome of an action the user just took, where
 * the result is worth confirming but not worth leaving on screen.
 */

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional second line, e.g. what exactly the device reported. */
  detail?: string;
}

/** Successes are self-evident and can go quickly; failures need reading. */
const DISMISS_MS: Record<ToastKind, number> = {
  success: 3200,
  info: 3800,
  error: 6500,
};

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, kind, message, detail }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_MS[kind]),
      );
      return id;
    },
    [dismiss],
  );

  // Timers outlive the render that scheduled them, so clear them on unmount
  // rather than letting them fire into a dead component.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

const ICONS: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  info: "•",
};

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export default function ToastStack({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    // aria-live so the outcome reaches a screen reader without stealing
    // focus; "polite" because nothing here interrupts a task.
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span className="toast-icon" aria-hidden="true">
            {ICONS[t.kind]}
          </span>
          <div className="toast-body">
            <p className="toast-message">{t.message}</p>
            {t.detail && <p className="toast-detail">{t.detail}</p>}
          </div>
          <button className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
