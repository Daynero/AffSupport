import { useId, useState } from 'react';
import { Download } from 'lucide-react';
import type { TranscriptionModelInfo } from '@video-compressor/shared';
import { Button, ProgressBar, type Translate } from '../components/ui';
import { formatSize } from '../format';
import type { Language } from '../i18n';
import { GemmaConsent } from './GemmaConsent';

/**
 * The translation column when there is no translator: what it costs, the consent, the
 * button — or the download's progress once it is running.
 */
export function TranslatorNotice({
  translatorModel,
  language,
  onInstall,
  onCancel,
  t
}: {
  translatorModel: TranscriptionModelInfo;
  language: Language;
  onInstall: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  const [accepted, setAccepted] = useState(false);
  const hintId = useId();
  if (translatorModel.downloading) {
    return (
      <div className="transcript-translation-notice is-downloading" role="status">
        <span>
          {t('transcriptionTranslatorInstalling', { progress: translatorModel.progress ?? 0 })}
        </span>
        <ProgressBar
          value={translatorModel.progress}
          active
          label={t('transcriptionTranslatorInstall')}
        />
        <div className="transcription-consent-actions">
          <Button variant="ghost" onClick={onCancel}>
            {t('transcriptionModelCancelBtn')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="transcript-translation-notice">
      <p className="transcript-translation-notice-lead">
        {t('transcriptionTranslatorIntro', {
          size: formatSize(translatorModel.sizeBytes || 2_500_000_000, language)
        })}
      </p>
      <GemmaConsent checked={accepted} onChange={setAccepted} t={t} />
      {translatorModel.error && (
        <p className="transcription-model-error">
          {translatorModel.error === 'MODEL_SOURCE_NOT_CONFIGURED'
            ? t('transcriptionTranslatorNotConfigured')
            : t('transcriptionTranslationFailed')}
        </p>
      )}
      {/* Pinned to the bottom of the column while the rest scrolls: a button cut in half by
          the fold read as a bug, not as "scroll for more". The hint sits above the button
          rather than under it, so the thing it explains is the last thing read before the
          click — and the button keeps the column's own left edge. */}
      <div className="transcription-consent-actions">
        {!accepted && (
          <p id={hintId} className="transcription-consent-hint">
            {t('transcriptionConsentHint')}
          </p>
        )}
        <Button
          variant="primary"
          disabled={!accepted}
          aria-describedby={accepted ? undefined : hintId}
          onClick={onInstall}
        >
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />
          {t('transcriptionTranslatorInstall')}
        </Button>
      </div>
    </div>
  );
}

/**
 * What this translation is good for, said once where the translation is read.
 *
 * A four-billion-parameter model running on a laptop is enough to know what a creative
 * claims and in what tone; it is not the thing to write the published copy with. Saying so
 * plainly is cheaper than a person discovering it after shipping.
 */
export function TranslationCaveat({ t }: { t: Translate }) {
  return <p className="transcript-translation-caveat">{t('transcriptionTranslationCaveat')}</p>;
}
