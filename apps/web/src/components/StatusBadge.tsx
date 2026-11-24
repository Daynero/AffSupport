import type { JobStatus } from '@video-compressor/shared';
import type { Translate, TranslationKey } from '../i18n';
import { SotyLoader, TranscriptionLoader } from './SotyLoader';

/**
 * A job's status, as the tool screens' rows say it (moved out of the pre-021
 * shim, 070 T035). A product component, not an inventory one: the words are
 * the job's, and the loader inside is the brand's. Its colour is one of the
 * inventory's roles, so the same state is the same colour everywhere.
 */
export function StatusBadge({
  status,
  t,
  context = 'compression'
}: {
  status: JobStatus;
  t: Translate;
  context?: 'compression' | 'transcription' | 'stitch';
}) {
  const keys: Record<JobStatus, TranslationKey> = {
    analyzing: 'statusAnalyzing',
    ready: 'statusReady',
    queued: 'statusQueued',
    processing:
      context === 'transcription'
        ? 'transcriptionProcessing'
        : context === 'stitch'
          ? 'stitcherProcessing'
          : 'statusProcessing',
    completed: 'statusCompleted',
    failed: 'statusFailed',
    cancelled: 'statusCancelled',
    interrupted: 'statusInterrupted'
  };
  /* Each status carries a role, so the same state is the same colour wherever
     it appears — a failed job, a failed upload and a failed render agree. */
  const color: Record<JobStatus, 'neutral' | 'info' | 'success' | 'error' | 'warning'> = {
    analyzing: 'info',
    ready: 'neutral',
    queued: 'neutral',
    processing: 'info',
    completed: 'success',
    failed: 'error',
    cancelled: 'neutral',
    interrupted: 'warning'
  };
  return (
    <span className={`status-badge status-${status} ui-color-${color[status]}`}>
      {status === 'processing' ? (
        context === 'transcription' ? (
          <TranscriptionLoader size={13} />
        ) : (
          <SotyLoader size={13} />
        )
      ) : status === 'completed' ? (
        <svg
          className="status-check"
          width="11"
          height="11"
          viewBox="0 0 12 12"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M2.5 6.5 5 9 9.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <i aria-hidden="true" />
      )}
      {t(keys[status])}
    </span>
  );
}
