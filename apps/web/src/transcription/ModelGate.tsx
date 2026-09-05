import { useId, useState } from 'react';
import { Download, X } from 'lucide-react';
import { combineModelInfo, type TranscriptionModelInfo } from '@video-compressor/shared';
import { Modal } from '../components/Modal';
import { Button, ProgressBar, type Translate } from '../components/ui';
import { formatSize } from '../format';
import type { Language } from '../i18n';
import { GemmaConsent } from './GemmaConsent';

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
  // the translation bundle, when the person asked for speech alone — is not "queued".
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
          <span className="transcription-model-error">
            {t('transcriptionModelError', { error: model.error })}
          </span>
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

/**
 * The one-time confirmation before anything is downloaded.
 *
 * Names what is missing and how much it weighs. When only the translation bundle is
 * missing the person can go on without it — and that choice is remembered by the agent, so
 * the prompt is not repeated on every start.
 */
export function ConfirmDownloadModal({
  speechModel,
  translationBundle,
  language,
  willStart,
  translatorOnly = false,
  onConfirm,
  onContinueWithoutTranslation,
  onClose,
  t
}: {
  speechModel: TranscriptionModelInfo;
  translationBundle: TranscriptionModelInfo;
  language: Language;
  /** Whether files are waiting to run the moment the download lands. */
  willStart: boolean;
  /** The translator on its own, asked for from a row: no "without translation" way out. */
  translatorOnly?: boolean;
  onConfirm: (includeTranslation: boolean) => void;
  onContinueWithoutTranslation: () => void;
  onClose: () => void;
  t: Translate;
}) {
  const requiresGemmaConsent = !translationBundle.present;
  const [accepted, setAccepted] = useState(!requiresGemmaConsent);
  const titleId = useId();
  const hintId = useId();
  const missing = [speechModel, translationBundle].filter(part => !part.present);
  const sizeLabel = formatSize(
    missing.reduce((sum, part) => sum + part.sizeBytes, 0),
    language
  );

  return (
    <Modal size="sm" className="transcription-confirm-modal" labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId}>
        {translatorOnly ? t('transcriptionTranslatorInstall') : t('transcriptionConfirmTitle')}
      </h2>
      <p>{t('transcriptionConfirmBody', { size: sizeLabel })}</p>
      <ul className="transcription-confirm-parts">
        {!speechModel.present && (
          <li>
            <span>{t('transcriptionConfirmSpeechModel', { label: speechModel.label })}</span>
            <span>{formatSize(speechModel.sizeBytes, language)}</span>
          </li>
        )}
        {!translationBundle.present && (
          <li>
            <span>{t('transcriptionConfirmTranslationModels')}</span>
            <span>{formatSize(translationBundle.sizeBytes, language)}</span>
          </li>
        )}
      </ul>
      {requiresGemmaConsent && <GemmaConsent checked={accepted} onChange={setAccepted} t={t} />}
      {requiresGemmaConsent && !accepted && (
        <p id={hintId} className="transcription-consent-hint">
          {t('transcriptionConsentHint')}
        </p>
      )}
      <div className="inline-actions">
        <Button variant="ghost" onClick={onClose}>
          {t('transcriptionConfirmCancel')}
        </Button>
        {requiresGemmaConsent && !translatorOnly && (
          <Button variant="secondary" onClick={onContinueWithoutTranslation}>
            {speechModel.present
              ? t('transcriptionContinueWithoutTranslation')
              : t('transcriptionDownloadSpeechOnly')}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!accepted}
          aria-describedby={accepted ? undefined : hintId}
          onClick={() => onConfirm(true)}
        >
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />
          {willStart ? t('transcriptionConfirmDownload') : t('transcriptionConfirmDownloadOnly')}
        </Button>
      </div>
    </Modal>
  );
}
