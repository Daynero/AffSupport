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
 * what will run sits beside it, outside the name. The whole strip still takes the click, and
 * the row itself takes it (owner, 25.11): the button's hit area used to be stretched over the
 * row with `::after`, but React Aria counts a press only inside the button's own box, so a
 * click on the summary or the chevron was released "outside" and dropped — only the title
 * folded the panel. The button stays the one keyboard stop and the name; a pointer anywhere
 * else on the strip folds it too.
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
    <div
      className="settings-collapse-row section-heading"
      onClick={event => {
        // The button answers for itself; the rest of the strip is its larger target.
        if (!(event.target as Element).closest('.settings-collapse')) onToggle();
      }}
    >
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
