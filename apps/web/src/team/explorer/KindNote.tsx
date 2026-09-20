import { Info } from 'lucide-react';
import { ICON_STROKE } from '../../components/icons';

/**
 * A fact about a kind of file, said by an icon (024, FR-095).
 *
 * "Opens in Google Drive, not in Soty" is true of every Google document, so it
 * was a second line under every one of them — a caption the reader learns once
 * and then has to read past forever. The words stay one hover or one focus
 * away, and in the accessible name.
 */
export function KindNote({ text }: { text: string }) {
  return (
    <span
      className="team-explorer-kind-note"
      role="img"
      aria-label={text}
      title={text}
      tabIndex={0}
    >
      <Info size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
    </span>
  );
}
