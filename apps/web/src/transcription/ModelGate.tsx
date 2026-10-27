import { useId } from 'react';
import { Download, X } from 'lucide-react';
import { combineModelInfo, type TranscriptionModelInfo } from '@video-compressor/shared';
import { Modal } from '../components/Modal';
import { Button, ProgressBar, type Translate } from '../components/ui';
import { formatSize } from '../format';
import type { Language } from '../i18n';
import { Alert } from '../components/ui/index';

export { combineModelInfo };

/** The band above the queue while the speech model of the chosen mode is missing. */
export function ModelGate({
  model,
  parts,
  language,
  onDownload,
  onCancel,
  t
}: {
  model: TranscriptionModelInfo;
  parts: readonly TranscriptionModelInfo[];
  language: Language;
  onDownload: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  const size = formatSize(model.sizeBytes, language);
  // Only what this download is actually fetching. A model that was left out on purpose —
  const batchId = parts.find(part => part.downloading)?.downloadBatchId ?? null;
  const visibleParts = parts.filter(
    part => part.downloading || part.error || (batchId !== null && part.downloadBatchId === batchId)
  );
  return (
    <section className="transcription-model-gate">
      <div className="transcription-model-gate-body">
        <strong>{t('transcriptionModelTitle')}</strong>
        {model.downloading ? (
          <>
            {/* Announced when it changes meaningfully — the percentage, not every byte. */}
            <span aria-live="polite" aria-atomic="true">
              {t('transcriptionModelDownloading', {
                progress: model.progress ?? 0,
                done: formatSize(model.downloadedBytes, language),
                total: size
              })}
            </span>
            <ProgressBar value={model.progress} active label={t('transcriptionModelTitle')} />
            {visibleParts.length > 1 && (
              <ul className="transcription-model-parts">
                {visibleParts.map(part => (
                  <li key={part.label}>
                    <span>{part.label}</span>
                    <span>
                      {part.present
                        ? t('transcriptionModelReady')
                        : part.downloading
                          ? `${part.progress ?? 0}%`
                          : part.error
                            ? t('statusFailed')
                            : t('statusQueued')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : model.error ? (
          /* Announced, and named as well as coloured: the word "failed" carries
             the state for a reader who cannot see the red (FR-032). */
          <Alert
            className="transcription-model-error"
            color="error"
            variant="soft"
            live="alert"
            title={t('statusFailed')}
          >
            {t('transcriptionModelError', { error: model.error })}
          </Alert>
        ) : (
          <span>{t('transcriptionModelBody', { size })}</span>
        )}
      </div>
      <div className="transcription-model-gate-actions">
        {model.downloading ? (
          <Button variant="ghost" onClick={onCancel}>
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
            {t('transcriptionModelCancelBtn')}
          </Button>
        ) : (
          <Button variant="primary" onClick={onDownload}>
            <Download size={16} strokeWidth={1.75} aria-hidden="true" />
            {model.error
              ? t('transcriptionModelRetry')
              : t('transcriptionModelDownloadBtn', { size })}
          </Button>
        )}
      </div>
    </section>
  );
}

export function ConfirmDownloadModal({
  speechModel,
  language,
  willStart,
  onConfirm,
  onClose,
  t
}: {
  speechModel: TranscriptionModelInfo;
  language: Language;
  willStart: boolean;
  onConfirm: () => void;
  onClose: () => void;
  t: Translate;
}) {
  const titleId = useId();
  return (
    <Modal size="sm" className="transcription-confirm-modal" labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId}>{t('transcriptionConfirmTitle')}</h2>
      <p>{t('transcriptionConfirmBody', { size: formatSize(speechModel.sizeBytes, language) })}</p>
      <ul className="transcription-confirm-parts">
        <li>
          <span>{t('transcriptionConfirmSpeechModel', { label: speechModel.label })}</span>
          <span>{formatSize(speechModel.sizeBytes, language)}</span>
        </li>
      </ul>
      <div className="inline-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('transcriptionCancel')}
        </Button>
        <Button onClick={onConfirm}>
          {t(willStart ? 'transcriptionConfirmDownload' : 'transcriptionConfirmDownloadOnly')}
        </Button>
      </div>
    </Modal>
  );
}
