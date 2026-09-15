import type { ReactNode } from 'react';
import { EmptyState, Spinner } from '../../components/ui/index';

/**
 * The gallery's empty, searching and failed states (021, T070).
 *
 * It kept its own markup for the same four parts the shared pattern has, so it
 * is that pattern now with its class carried through — the viewer's stylesheet
 * still dresses it, and the shape is the one every other empty state uses.
 */
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
    <EmptyState
      className="lv-empty"
      icon={busy ? <Spinner /> : icon}
      title={title}
      description={body ?? undefined}
      action={action}
    />
  );
}
