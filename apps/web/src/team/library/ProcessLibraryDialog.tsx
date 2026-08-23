import { useEffect, useId, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { teamErrorMessage } from '../errors';
import { useLibraryProcessing } from './LibraryProcessingProvider';

export {
  stableLibraryAgentInstanceId,
  type ProcessLibraryAgent,
  type ProcessLibraryClient
} from './process-library-contract';

/**
 * A window onto the space's batch, not the batch itself.
 *
 * Everything that runs lives in `LibraryProcessingProvider`; closing this
 * dialog now changes nothing about the work (finding B1, FR-032). Cancelling is
 * a separate, confirmed decision — which is what closing a window used to mean
 * by accident.
 */
export function ProcessLibraryDialog({
  sourceMaterialId,
  agentCompatible,
  onClose
}: {
  sourceMaterialId?: string;
  agentCompatible: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const batch = useLibraryProcessing();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const cancelTitleId = useId();

  // A dialog opened onto an idle batch scans, so the counts are current. A
  // running one is left alone: a rescan mid-run would fight the loop. Keyed on
  // the phase rather than on mount, so it is a rule about the state rather than
  // a rule about when the component happened to appear.
  const idle = batch.phase === 'idle';
  const rescan = batch.rescan;
  useEffect(() => {
    if (idle) void rescan();
  }, [idle, rescan]);

  const settled = batch.done + batch.skipped + batch.failed;

  return (
    <Modal
      labelledBy="creative-library-process-title"
      onClose={onClose}
      closeLabel={t('teamClose')}
      size="xl"
    >
      <section className="creative-library-process">
        <p className="team-workspace-eyebrow">{t('creativeLibraryProcessEyebrow')}</p>
        <h2 id="creative-library-process-title">
          {sourceMaterialId
            ? t('creativeLibraryTranscribeVideoTitle')
            : t('creativeLibraryProcessTitle')}
        </h2>
        {batch.phase === 'scanning' && (
          <p aria-live="polite">{t('creativeLibraryProcessScanning')}</p>
        )}
        {batch.scan && (
          <div
            className="creative-library-process-counts"
            aria-label={t('creativeLibraryProcessCounts')}
          >
            <div>
              <strong>{batch.scan.missing.transcription}</strong>
              <span>{t('creativeLibraryProcessTranscriptions')}</span>
            </div>
            <div>
              <strong>{batch.scan.missing.translation}</strong>
              <span>{t('creativeLibraryProcessTranslations')}</span>
            </div>
            {!sourceMaterialId && (
              <div>
                <strong>{batch.scan.missing.landingOptimization}</strong>
                <span>{t('creativeLibraryProcessLandings')}</span>
              </div>
            )}
          </div>
        )}
        {batch.phase === 'ready' && batch.total > 0 && (
          <p>{t('creativeLibraryProcessConfirmation', { count: batch.total })}</p>
        )}
        {batch.phase === 'ready' && batch.total === 0 && (
          <p>{t('creativeLibraryProcessNothing')}</p>
        )}
        {!agentCompatible && <p className="team-inline-error">{t('teamProcessAgentUpdate')}</p>}
        {agentCompatible && batch.supportedKinds.length === 0 && (
          <p className="team-inline-error">{t('teamProcessToolUpdate')}</p>
        )}
        {batch.phase === 'running' && (
          <div className="creative-library-process-progress" aria-live="polite">
            <progress max={Math.max(batch.total, settled, 1)} value={settled} />
            <span>
              {t('creativeLibraryProcessProgress', {
                completed: batch.done,
                total: Math.max(batch.total, settled)
              })}
            </span>
            {batch.activeKind && (
              <small>{t('creativeLibraryProcessActive', { kind: batch.activeKind })}</small>
            )}
          </div>
        )}
        {settled > 0 && (
          <p>
            {t('creativeLibraryProcessResults', {
              completed: batch.done,
              skipped: batch.skipped,
              failed: batch.failed
            })}
          </p>
        )}
        {batch.phase === 'canceled' && <p>{t('creativeLibraryProcessCanceled')}</p>}
        {batch.phase === 'complete' && <p>{t('creativeLibraryProcessComplete')}</p>}
        {batch.errorCode && (
          <p className="team-inline-error">{teamErrorMessage(batch.errorCode, t)}</p>
        )}
        <div className="team-dialog-actions">
          {batch.phase !== 'running' && batch.total > 0 && (
            <Button
              type="button"
              variant="primary"
              disabled={batch.supportedKinds.length === 0}
              onClick={() => void batch.start()}
            >
              {t('creativeLibraryProcessStart')}
            </Button>
          )}
          {batch.phase === 'running' && (
            <Button type="button" variant="secondary" onClick={() => setConfirmingCancel(true)}>
              {t('creativeLibraryProcessCancel')}
            </Button>
          )}
          {batch.failed > 0 && batch.phase !== 'running' && (
            <Button type="button" variant="secondary" onClick={() => void batch.retryFailed()}>
              {t('creativeLibraryProcessRetry')}
            </Button>
          )}
          {/* "Done" closes the window. The run, if any, carries on. */}
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('creativeLibraryDone')}
          </Button>
        </div>
      </section>
      {confirmingCancel && (
        <Modal
          nested
          labelledBy={cancelTitleId}
          size="sm"
          onClose={() => setConfirmingCancel(false)}
        >
          <h3 id={cancelTitleId}>{t('creativeLibraryProcessCancelConfirmTitle')}</h3>
          <p>{t('creativeLibraryProcessCancelConfirmBody')}</p>
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirmingCancel(false);
                void batch.cancel();
              }}
            >
              {t('creativeLibraryProcessCancel')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmingCancel(false)}>
              {t('teamCancel')}
            </Button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
