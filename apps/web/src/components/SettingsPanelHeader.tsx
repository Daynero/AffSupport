import type { ReactNode } from 'react';
import { ChevronDown, Settings as SettingsIcon } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from './icons';
import { Button } from './ui/index';

/**
 * The folding header of a tool's settings panel (070 T035–T037).
 *
 * The compressor, the stitcher, the transcription and the landing optimizer fold their settings
 * the same way, and each wrote the same raw `<button>` around an `<h2>`: a heading inside a
 * button is no heading at all, so a screen reader's list of headings skipped every panel.
 *
 * Here the heading holds the inventory's button (the accordion pattern), and the summary of
 * what will run sits beside it, outside the name. The whole strip still takes the click: the
 * button's hit area is stretched over the row in CSS (`.settings-collapse::after`), so pressing
 * the summary or the chevron folds the panel as it always did.
 */
export function SettingsPanelHeader({
  title,
  titleId,
  bodyId,
  open,
  onToggle,
  summary
}: {
  title: string;
  titleId: string;
  bodyId: string;
  open: boolean;
  onToggle: () => void;
  /** What will run, in a few words. Stays put when the panel opens. */
  summary?: ReactNode;
}) {
  return (
    <div className="settings-collapse-row section-heading">
      <h2 id={titleId} className="settings-collapse-heading">
        <Button
          color="neutral"
          variant="ghost"
          className="settings-collapse"
          aria-expanded={open}
          aria-controls={bodyId}
          leading={<SettingsIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          onClick={onToggle}
        >
          {title}
        </Button>
      </h2>
      {summary && <span className="settings-summary">{summary}</span>}
      <ChevronDown
        size={ICON_SIZE}
        strokeWidth={ICON_STROKE}
        className={`settings-chevron${open ? '' : ' is-rotated'}`}
        aria-hidden="true"
      />
    </div>
  );
}
