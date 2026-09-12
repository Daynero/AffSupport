/**
 * One panel of space settings, shaped like the compressor's settings panel.
 *
 * Every panel here used to be a bare `h2` followed by a paragraph and a control, all in the
 * dialog's own surface colour: eight cards of the same tone stacked into one wall, with the
 * section titles reading smaller than the 52px fields under them. The compressor already had
 * the answer — a violet-tinted slab, an icon, a title, and the current state summarised on the
 * right of the same line — so this repeats that shape instead of inventing a second one.
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';

export function SettingsSection({
  icon: Icon,
  title,
  titleId,
  description,
  aside,
  className,
  children
}: {
  icon: LucideIcon;
  title: ReactNode;
  titleId: string;
  /** Said once, under the title, at the size of a caption — never competing with it. */
  description?: ReactNode;
  /** The panel's current state, on the title line, where the compressor keeps its summary. */
  aside?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className={`team-panel settings-section${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
    >
      <div className="settings-section-heading">
        <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <h2 id={titleId}>{title}</h2>
        {aside !== undefined && aside !== null && aside !== false && (
          <span className="settings-section-aside">{aside}</span>
        )}
      </div>
      {description !== undefined && description !== null && description !== false && (
        <p className="settings-section-note">{description}</p>
      )}
      {children}
    </section>
  );
}
