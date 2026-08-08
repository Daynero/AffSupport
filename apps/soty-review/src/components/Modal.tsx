import { useEffect, useRef, type ReactNode } from 'react';
import { Action } from './Action';

export function Modal({
  title,
  onClose,
  children
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = dialog.current?.parentElement;
    const background = backdrop?.parentElement
      ? [...backdrop.parentElement.children].filter(element => element !== backdrop)
      : [];
    const previousInert = background.map(element => element.hasAttribute('inert'));
    background.forEach(element => element.setAttribute('inert', ''));
    dialog.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialog.current) return;
      const controls = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          'button,[href],[tabindex]:not([tabindex="-1"])'
        )
      ];
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('keydown', keyDown);
      background.forEach((element, index) => {
        if (!previousInert[index]) element.removeAttribute('inert');
      });
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="soty-modal-backdrop">
      <div
        ref={dialog}
        className="soty-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="soty-modal-title"
        tabIndex={-1}
      >
        <h2 id="soty-modal-title">{title}</h2>
        {children}
        <Action variant="secondary" reviewId="modal/close" onClick={onClose}>
          Закрити
        </Action>
      </div>
    </div>
  );
}
