import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import './modal.css';

/** Modal sobre <dialog> nativo: foco preso, Esc fecha, fundo inerte. */
export function Modal({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={label}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar">
          <Icon name="close" />
        </button>
        {open && children}
      </div>
    </dialog>
  );
}
