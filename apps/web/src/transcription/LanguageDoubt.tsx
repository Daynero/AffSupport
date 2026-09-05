import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import {
  confusableLanguages,
  TRANSCRIPTION_LANGUAGE_CODES,
  type TranscriptionJob
} from '@video-compressor/shared';
import { useAnchoredLayer } from '../components/useAnchoredLayer';
import type { Translate } from '../components/ui';
import type { Language } from '../i18n';
import { languageDisplayName } from './language';

/** Keep in sync with the panel's width in transcription.css; see `useAnchoredLayer`. */
const PANEL_WIDTH = 320;

/**
 * What the probe actually heard, and every way to correct it.
 *
 * Whisper's language head is close to a coin toss inside a few families, and a lone
 * question-mark tooltip saying so left the person with nothing to do about it. This shows
 * the measurement — which language won each thirty-second fragment, and how sure the model
 * was of it — and makes every line a button, including the family neighbours the
 * detector never votes for but keeps confusing this one with. Uzbek is exactly that case:
 * it is why the file is labelled Azerbaijani and why it is not in the list of winners.
 */
export function LanguageDoubt({
  job,
  language,
  disabled,
  onChoose,
  t,
  /** The language picker, which sits between the two things that open this panel. */
  children
}: {
  job: TranscriptionJob;
  language: Language;
  disabled: boolean;
  onChoose: (code: string) => void;
  t: Translate;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const shareTrigger = useRef<HTMLButtonElement>(null);
  // Whichever of the two was pressed gets the focus back when the panel closes.
  const opener = useRef<HTMLButtonElement | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const panelStyle = useAnchoredLayer(anchor, layer, open, {
    minWidth: PANEL_WIDTH,
    // Tall enough for four readings plus the family chips; past that it scrolls.
    maxHeight: 460
  });
  const titleId = useId();

  // Closed by a press anywhere else, including on another row's marker. Pointerdown rather
  // than click, so the panel is gone before whatever was pressed reacts.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        anchor.current?.contains(target) ||
        shareTrigger.current?.contains(target) ||
        layer.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  const dismiss = () => {
    setOpen(false);
    opener.current?.focus();
  };
  const toggle = (trigger: HTMLButtonElement | null) => {
    opener.current = trigger;
    setOpen(value => !value);
  };

  const detected = job.detectedLanguage;
  /*
   * Only a probe leaves numbers behind.
   *
   * A language the transcription itself reported — or one restored from a version of the
   * app that had no probe — has no fragments and no confidence, and inventing a bar for it
   * would be the one thing this panel exists not to do. It then offers the neighbours
   * alone, which is still the correction the person came here for.
   */
  const measured =
    (job.languageCandidates?.length ?? 0) > 0 || job.languageConfidence !== undefined;
  // One fragment is the model's probability as it printed it; several are that probability
  // averaged over them. Both are readings, and the panel says which it is looking at.
  const candidates = job.languageCandidates?.length
    ? job.languageCandidates
    : measured && detected
      ? [{ language: detected, share: job.languageConfidence ?? 0 }]
      : [];
  const samples = job.languageSamples ?? 1;
  /*
   * Two different doubts, and they read differently.
   *
   * The fragments disagreed, or the model was not sure of the one it named — that is a
   * detector wavering. Or every fragment said the same thing, and said it confidently, and
   * the doubt is the family itself: Croatian at nine tenths, four times out of four, is
   * still the answer Serbian would have got.
   */
  const wavering = candidates.length > 1 || (candidates[0]?.share ?? 0) < 0.85;
  /*
   * Everything the model was sure of but did not name.
   *
   * whisper.cpp prints one winner per fragment and keeps the rest of that fragment's
   * probability to itself. Left out, the listed shares would be rescaled to a tidy hundred
   * per cent — which is how a marker saying "not sure" came to sit next to "100%".
   */
  const remainder = Math.max(
    0,
    1 - candidates.reduce((sum, candidate) => sum + candidate.share, 0)
  );
  const listed = new Set(candidates.map(candidate => candidate.language));
  const neighbours = confusableLanguages(detected).filter(
    code => !listed.has(code) && (TRANSCRIPTION_LANGUAGE_CODES as readonly string[]).includes(code)
  );
  const name = (code: string) => languageDisplayName(code, language);

  const choose = (code: string) => {
    dismiss();
    onChoose(code);
  };

  const panel = (
    <div
      ref={layer}
      role="dialog"
      aria-labelledby={titleId}
      className="transcription-language-doubt is-portal"
      style={panelStyle ?? undefined}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        dismiss();
      }}
    >
      <p id={titleId} className="transcription-language-doubt-title">
        {!measured
          ? t('transcriptionLanguageDoubtFromRun')
          : wavering
            ? t('transcriptionLanguageDoubtTitle')
            : t('transcriptionLanguageDoubtFamily')}
      </p>
      {measured && (
        <p className="transcription-language-doubt-scale">
          {samples > 1
            ? t('transcriptionLanguageDoubtSamples', { count: samples })
            : t('transcriptionLanguageDoubtSingle')}
        </p>
      )}
      {candidates.length > 0 && (
        <ul className="transcription-language-doubt-list">
          {candidates.map(candidate => {
            const percent = Math.round(candidate.share * 100);
            return (
              <li key={candidate.language}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-current={candidate.language === detected || undefined}
                  onClick={() => choose(candidate.language)}
                >
                  <span className="transcription-language-doubt-name">
                    {name(candidate.language)}
                  </span>
                  <span className="transcription-language-doubt-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(2, percent)}%` }} />
                  </span>
                  <span className="transcription-language-doubt-percent">
                    {percent > 0 ? `${percent}%` : '—'}
                  </span>
                </button>
              </li>
            );
          })}
          {remainder > 0.02 && (
            <li className="transcription-language-doubt-rest">
              <span className="transcription-language-doubt-name">
                {t('transcriptionLanguageDoubtRest')}
              </span>
              <span className="transcription-language-doubt-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(remainder * 100)}%` }} />
              </span>
              <span className="transcription-language-doubt-percent">
                {Math.round(remainder * 100)}%
              </span>
            </li>
          )}
        </ul>
      )}
      {neighbours.length > 0 && (
        <>
          {/* Deliberately not rows of the table above.
              These do not come from the recording at all — they are this language's family,
              written down in the app because Whisper is known to mix it up. Put in the
              table they read as measured and scored zero, which for the Serbian recording
              said the opposite of the truth. As buttons under a line that says where they
              came from, they are what they are: the shortcut to the right answer. */}
          <p className="transcription-language-doubt-also">{t('transcriptionLanguageDoubtAlso')}</p>
          <div className="transcription-language-doubt-neighbours">
            {neighbours.map(code => (
              <button key={code} type="button" disabled={disabled} onClick={() => choose(code)}>
                {name(code)}
              </button>
            ))}
          </div>
        </>
      )}
      <p className="transcription-language-doubt-note">{t('transcriptionLanguageDoubtApply')}</p>
    </div>
  );

  // The figure is the loudest thing about an uncertain guess, so it opens the panel too:
  // the mark before the name and the per cent after it are one control in two places.
  const topShare = candidates[0]?.share;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="transcription-language-doubt-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('transcriptionLanguageDoubt')}
        title={t('transcriptionLanguageDoubt')}
        onClick={event => toggle(event.currentTarget)}
      >
        <HelpCircle size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {children}
      {measured && topShare !== undefined && (
        <button
          ref={shareTrigger}
          type="button"
          className="transcription-row-language-share"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${Math.round(topShare * 100)}% · ${t('transcriptionLanguageDoubt')}`}
          title={t('transcriptionLanguageDoubt')}
          onClick={event => toggle(event.currentTarget)}
        >
          {Math.round(topShare * 100)}%
        </button>
      )}
      {open && createPortal(panel, document.body)}
    </>
  );
}
