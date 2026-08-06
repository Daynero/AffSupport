import type { ReactNode } from 'react';

export function NestedLevel({
  title,
  onBack,
  children
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby="nested-title">
      <button
        type="button"
        className="soty-back"
        onClick={onBack}
        data-review-id="nested/back"
        data-demo-action
      >
        ← Назад
      </button>
      <p className="soty-breadcrumb">Soty / Налаштування / {title}</p>
      <h2 id="nested-title">{title}</h2>
      {children}
    </section>
  );
}
