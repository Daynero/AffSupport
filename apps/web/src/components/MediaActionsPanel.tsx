import {
  isSettled,
  MEDIA_ACTION_LIFECYCLE,
  type MediaActionState,
  type MediaActionStatus
} from '@video-compressor/shared';
import type { TranslationKey } from '../i18n';
import { Button, type Translate } from './ui';

const LABELS: Record<MediaActionStatus, TranslationKey> = {
  queued: 'mediaActionQueued',
  processing: 'mediaActionProcessing',
  completed: 'mediaActionCompleted',
  failed: 'mediaActionFailed',
  skipped: 'mediaActionSkipped',
  cancelled: 'mediaActionCancelled'
};

function fileName(filePath: string) {
  // Both separators, because the path was produced by whichever file manager started it.
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/**
 * Conversions started outside this window.
 *
 * A Finder-initiated conversion has no window of its own, which is what made a wedged one
 * unstoppable short of quitting the application (A3). It is shown here, beside the queue
 * whose stream it rides, so that the machine working always has something on screen that
 * explains why — and a way to stop it.
 */
export function MediaActionsPanel({
  mediaActions,
  disabled,
  onStop,
  onStopAll,
  t
}: {
  mediaActions: MediaActionState | undefined;
  disabled: boolean;
  onStop: (id: string) => void;
  onStopAll: () => void;
  t: Translate;
}) {
  // Absent means this agent does not offer conversions at all; empty means none this
  // session. Neither is worth a heading over nothing.
  if (!mediaActions || mediaActions.jobs.length === 0) return null;

  const stoppable = mediaActions.jobs.filter(job => !isSettled(MEDIA_ACTION_LIFECYCLE, job.status));

  return (
    <section className="media-actions" aria-labelledby="media-actions-title" aria-live="polite">
      <header className="media-actions-header">
        <h2 id="media-actions-title">{t('mediaActionsTitle')}</h2>
        {stoppable.length > 0 && (
          <Button variant="ghost" disabled={disabled} onClick={onStopAll}>
            {t('mediaActionsStopAll')}
          </Button>
        )}
      </header>
      {/* Said plainly rather than left to be discovered: nothing here survives a restart,
          and a list that silently empties itself reads as work that was lost. */}
      <p className="media-actions-hint">{t('mediaActionsHint')}</p>
      <ul>
        {mediaActions.jobs.map(job => (
          <li key={job.id} className={`media-action media-action-${job.status}`}>
            <span className="media-action-name" title={job.inputPath}>
              {fileName(job.inputPath)}
            </span>
            <span className="media-action-status">
              {job.status === 'failed' && job.error ? job.error : t(LABELS[job.status])}
            </span>
            {isSettled(MEDIA_ACTION_LIFECYCLE, job.status) ? null : (
              <Button variant="ghost" disabled={disabled} onClick={() => onStop(job.id)}>
                {t('mediaActionsStop')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
