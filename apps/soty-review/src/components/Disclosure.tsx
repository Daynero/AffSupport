import type { ReactNode } from 'react';

export function Disclosure({
  open,
  onToggle,
  children
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="soty-disclosure">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        data-review-id="advanced/toggle"
        data-demo-action
      >
        Розширені налаштування <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="soty-disclosure-body">{children}</div>}
    </section>
  );
}
