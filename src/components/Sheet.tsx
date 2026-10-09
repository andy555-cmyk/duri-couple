import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Sheet({
  open,
  onClose,
  title,
  kicker,
  children,
  tall = false,
  closeLabel,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  kicker?: ReactNode;
  children: ReactNode;
  tall?: boolean;
  closeLabel: string;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  useEffect(() => {
    if (!open) return;
    // Focus moves into the sheet once when it opens and back afterwards (Codex review A3).
    // Depends on `open` only: callers pass a new onClose each render, which must not refocus.
    const previous = document.activeElement as HTMLElement | null;
    const field = closeRef.current?.closest('.sheet')?.querySelector<HTMLElement>('[autofocus], input, textarea');
    (field && field.hasAttribute('autofocus') ? field : closeRef.current)?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && closeFn.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        className={`sheet ${tall ? 'tall' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" />
        <button ref={closeRef} className="icon-button sheet-close" onClick={onClose} aria-label={closeLabel}>
          <Icon name="close" size={18} />
        </button>
        {kicker && <p className="sheet-kicker">{kicker}</p>}
        {title && (
          <h2 className="sheet-title" id={titleId}>
            {title}
          </h2>
        )}
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}
