import { useEffect, type ReactNode } from 'react';
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
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className={`sheet ${tall ? 'tall' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <button className="icon-button sheet-close" onClick={onClose} aria-label={closeLabel}>
          <Icon name="close" size={18} />
        </button>
        {kicker && <p className="sheet-kicker">{kicker}</p>}
        {title && <h2 className="sheet-title">{title}</h2>}
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}
