import type { ReactNode } from 'react';
import { Spinner } from '../../components/ui';

export function GalleryEmpty({
  title,
  body,
  busy = false,
  action
}: {
  title: string;
  body?: string | null;
  busy?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="landing-gallery-empty">
      {busy ? <Spinner /> : <span aria-hidden="true">▱</span>}
      <strong>{title}</strong>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}
