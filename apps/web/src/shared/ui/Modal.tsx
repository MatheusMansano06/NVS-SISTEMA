import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import './modal.css';

/** Modal sobre <dialog> nativo: foco preso, Esc fecha, fundo inerte. */
export function Modal({ open, onClose, children, label, wide }: { open: boolean; onClose: () => void; children: ReactNode; label: string; wide?: boolean | 'xl' }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // o showModal foca o primeiro botão (o ×): leva o foco para o campo marcado ou o primeiro campo
      const field = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.querySelector<HTMLElement>('input:not([type=hidden]):not([type=checkbox]), textarea, select');
      field?.focus();
      if (field instanceof HTMLInputElement && field.type === 'number') field.select();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={wide === 'xl' ? 'modal modal-xl' : wide ? 'modal modal-wide' : 'modal'}
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
