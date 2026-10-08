import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/** Modal built on the native <dialog> element: focus trap, Esc and backdrop for free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, []);

  const autoId = useId();
  const titleId = labelledBy ?? autoId;
  return (
    <dialog
      ref={ref}
      className={`dialog ${className ?? ""}`}
      aria-labelledby={title ? titleId : undefined}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog__inner">
          {title && (
            <header className="dialog__head">
              <h2 id={titleId} className="dialog__title">
                {title}
              </h2>
              <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
                <Icon name="x" />
              </button>
            </header>
          )}
          <div className="dialog__body">{children}</div>
          {footer && <footer className="dialog__foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function ProgressBar({
  value,
  label,
  indeterminate,
  tone,
}: {
  value: number;
  label: string;
  indeterminate?: boolean;
  tone?: "accent" | "warn" | "muted";
}) {
  return (
    <div
      className={`progress ${indeterminate ? "progress--indeterminate" : ""} ${tone ? `progress--${tone}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
    >
      <div className="progress__fill" style={indeterminate ? undefined : { width: `${value}%` }} />
    </div>
  );
}
