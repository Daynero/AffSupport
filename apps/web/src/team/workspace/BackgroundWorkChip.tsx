import { useI18n } from '../../i18n';
import { useOptionalLibraryProcessing } from '../library/LibraryProcessingProvider';

/**
 * Says that the space is busy, from anywhere in the space.
 *
 * Batch progress used to exist only inside the dialog that started it, so
 * closing the window left the run invisible as well as — until this feature —
 * cancelled (finding B1, FR-032). Visible only while something is running:
 * a permanent chip would stop being a signal.
 */
export function BackgroundWorkChip({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  const batch = useOptionalLibraryProcessing();
  if (!batch || batch.phase !== 'running') return null;

  const settled = batch.done + batch.skipped + batch.failed;
  // At least one more than is finished, because one is in flight right now. A
  // scan gives the real number; without one, "0 of 0" would be a lie.
  const total = Math.max(batch.total, settled + (batch.activeKind ? 1 : 0), 1);
  return (
    <button
      type="button"
      className="ui-chip ui-chip-busy team-background-chip"
      aria-label={t('creativeLibraryProcessChipOpen', { done: batch.done, total })}
      onClick={onOpen}
    >
      <span className="ui-chip-spinner" aria-hidden="true" />
      {t('creativeLibraryProcessChip', { done: batch.done, total })}
    </button>
  );
}
