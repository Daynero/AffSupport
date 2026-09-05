import type { ReactNode } from 'react';
import { Spinner } from '../../components/ui';

export function GalleryEmpty({
  icon,
  title,
  body,
  busy = false,
  action
}: {
  icon?: ReactNode;
  title: string;
  body?: string | null;
  busy?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="lv-empty">
      <span className="lv-empty-icon" aria-hidden="true">
        {busy ? <Spinner /> : icon}
      </span>
      <strong>{title}</strong>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}
