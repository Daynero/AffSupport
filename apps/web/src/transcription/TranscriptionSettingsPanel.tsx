import { memo, useEffect, useId, useState } from 'react';
import { ChevronDown, Settings as SettingsIcon, Target, Zap } from 'lucide-react';
import {
  TRANSCRIPTION_LANGUAGE_CODES,
  type TranscriptionQualityMode,
  type TranscriptionSettings
} from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { Tooltip, type Translate } from '../components/ui';
import type { Language } from '../i18n';
import { LanguageCombobox } from './LanguageCombobox';
import { languageDisplayName } from './language';

const SETTINGS_OPEN_KEY = 'soty.transcription.settings-open.v1';

/**
 * The two decisions a run needs: which language is spoken and how hard to listen.
 *
 * The quality switch is the one that decides whether the tool is usable at all on a
 * CPU-only laptop, so it sits beside the language rather than under an "advanced" fold. Both
 * controls are the compressor's: a field and a picto pair of the same height, each with the
 * chosen value spelled out under it in as few words as it takes.
 */
export const TranscriptionSettingsPanel = memo(function TranscriptionSettingsPanel({
  settings,
  language,
  disabled,
  /** Open until the person folds it, when there is nothing else on the page yet. */
  defaultOpen,
  onLanguage,
  onQuality,
  t
}: {
  settings: TranscriptionSettings;
  language: Language;
  disabled: boolean;
  defaultOpen: boolean;
  onLanguage: (value: string) => void;
  onQuality: (value: TranscriptionQualityMode) => void;
  t: Translate;
}) {
  const languageFieldId = useId();
  const titleId = useId();
  const bodyId = useId();
  // Folds to its summary line once the choices are made, and remembers: on a laptop the
  // open panel plus the intake left no file above the fold. Open by default the first time,
  // because the speed choice is the one decision a new person should see.
  // Until the person folds or unfolds it, the panel follows the page: open on an empty
  // page, folded once files are on it — and the choice, once made, is remembered.
  const [chosen, setChosen] = useState<boolean | null>(() => {
    try {
      const stored = localStorage.getItem(SETTINGS_OPEN_KEY);
      if (stored === 'open') return true;
      if (stored === 'closed') return false;
    } catch {
      // Private windows: the default applies.
    }
    return null;
  });
  const open = chosen ?? defaultOpen;
  useEffect(() => {
    if (chosen === null) return;
    try {
      localStorage.setItem(SETTINGS_OPEN_KEY, chosen ? 'open' : 'closed');
    } catch {
      // Private windows: the choice lasts for the page's life.
    }
  }, [chosen]);
  const quality = settings.quality ?? 'fast';
  const languageName =
    settings.language === 'auto'
      ? t('transcriptionLanguageAuto')
      : languageDisplayName(settings.language, language);
  const qualityName =
    quality === 'fast' ? t('transcriptionQualityFast') : t('transcriptionQualityAccurate');
  return (
    <section
      className={`settings-panel transcription-settings-panel${open ? '' : ' is-collapsed'}`}
      aria-labelledby={titleId}
    >
      {/* The compressor's strip, so the two tools fold the same way: the whole header is the
          toggle, the current choices sit in the middle and stay put when it opens. */}
      <button
        type="button"
        className="settings-collapse section-heading compact-heading"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setChosen(!open)}
      >
        <SettingsIcon size={18} strokeWidth={1.75} aria-hidden="true" />
        <h2 id={titleId}>{t('transcriptionSettingsTitle')}</h2>
        <span className="settings-summary">
          <span>
            <span className="settings-summary-key">{t('transcriptionSummaryLanguage')}</span>
            {languageName}
          </span>
          <span>
            <span className="settings-summary-key">{t('transcriptionSummaryQuality')}</span>
            {qualityName}
          </span>
        </span>
        <ChevronDown
          size={18}
          strokeWidth={1.75}
          className={`settings-chevron${open ? '' : ' is-rotated'}`}
          aria-hidden="true"
        />
      </button>
      <div id={bodyId} className="settings-body" hidden={!open}>
        <div className="transcription-settings-grid">
          <div className="field-group transcription-language-field">
            <div className="field-label">
              <span id={languageFieldId}>{t('transcriptionLanguage')}</span>
              <Tooltip label={t('transcriptionLanguageHintShort')}>
                {t('transcriptionLanguageHint')}
              </Tooltip>
            </div>
            {/* The same searchable picker the translation target uses, so there is one way
              to choose a language in this tool. */}
            <LanguageCombobox
              value={settings.language}
              codes={TRANSCRIPTION_LANGUAGE_CODES}
              language={language}
              label={t('transcriptionLanguage')}
              ariaLabelledBy={languageFieldId}
              autoLabel={t('transcriptionLanguageAuto')}
              emptyLabel={t('transcriptionLanguageNoMatch')}
              disabled={disabled}
              onChange={onLanguage}
            />
          </div>
          <div className="field-group transcription-quality-field">
            <div className="field-label">
              <span>{t('transcriptionQuality')}</span>
              <Tooltip label={t('transcriptionQualityHintShort')}>
                {t('transcriptionQualityHint')}
              </Tooltip>
            </div>
            {/* The compressor's picto pair: two marks in one bordered group, and the choice
                spelled out under it. Which model each mode loads is the download band's
                business, not this line's. */}
            <div
              className="fit-mode-pictos"
              role="radiogroup"
              aria-label={t('transcriptionQuality')}
            >
              <button
                type="button"
                role="radio"
                className={quality === 'fast' ? 'is-selected' : ''}
                // The mark alone says nothing; its tip names the mode and what it is for.
                data-tip={`${t('transcriptionQualityFast')} · ${t('transcriptionQualityFastBody')}`}
                aria-label={t('transcriptionQualityFast')}
                aria-checked={quality === 'fast'}
                disabled={disabled}
                onClick={() => onQuality('fast')}
              >
                <Zap size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="radio"
                className={quality === 'accurate' ? 'is-selected' : ''}
                data-tip={`${t('transcriptionQualityAccurate')} · ${t('transcriptionQualityAccurateBody')}`}
                aria-label={t('transcriptionQualityAccurate')}
                aria-checked={quality === 'accurate'}
                disabled={disabled}
                onClick={() => onQuality('accurate')}
              >
                <Target size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
            </div>
            <p className="transcription-quality-note">
              {qualityName} ·{' '}
              {quality === 'fast'
                ? t('transcriptionQualityFastBody')
                : t('transcriptionQualityAccurateBody')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
});
