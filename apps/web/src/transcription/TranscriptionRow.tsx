import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Copy,
  Download,
  Eye,
  FolderOpen,
  Globe,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react';
import {
  TRANSCRIPTION_LANGUAGE_CODES,
  TRANSCRIPTION_LIFECYCLE,
  TRANSLATEGEMMA_LANGUAGE_CODES,
  confusableLanguages,
  isSettled,
  type TranscriptionJob,
  type TranscriptionQualityMode
} from '@video-compressor/shared';
import { Button, Checkbox, ProgressBar, StatusBadge, type Translate } from '../components/ui';
import { formatDuration } from '../format';
import type { Language } from '../i18n';
import type { TranscriptExportContent, TranscriptExportFormat } from './export';
import { ExportMenu } from './ExportMenu';
import { LanguageCombobox } from './LanguageCombobox';
import { LanguageDoubt } from './LanguageDoubt';
import { isRtlLanguage } from './language';
import { describeError } from './errors';

/**
 * What a row can ask the page to do. One object, stable for the page's lifetime, keyed by
 * job id — so the row can be memoised and a progress tick on one file leaves the other
 * hundred rows untouched.
 */
export interface TranscriptionRowActions {
  select: (id: string, index: number, checked: boolean, shiftKey: boolean) => void;
  start: (id: string) => void;
  /** Runs one file again on a named quality, leaving the setting alone. */
  startWith: (id: string, quality: TranscriptionQualityMode) => void;
  cancel: (id: string) => void;
  pause: (id: string, paused: boolean) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  reveal: (id: string) => void;
  /** Opens the translator install flow; shown where a row says the translator is missing. */
  installTranslator: () => void;
  /** Names the spoken language by hand; `auto` hands the question back to the machine. */
  setLanguage: (id: string, language: string) => void;
  view: (id: string, trigger: HTMLElement | null) => void;
  copy: (id: string) => Promise<boolean>;
  translate: (id: string, targetLanguage: string) => Promise<void>;
  export: (id: string, format: TranscriptExportFormat, content: TranscriptExportContent) => void;
}

/**
 * Below this many characters per audible second a fast transcript is called short. Normal
 * speech lands around twelve to fifteen; a music bed the turbo model gave up on lands near
 * zero for the part it missed, and a file that is half silence still clears the bar.
 */
const SHORT_TRANSCRIPT_CHARS_PER_SECOND = 5;

export const TranscriptionRow = memo(function TranscriptionRow({
  job,
  index,
  language,
  connected,
  selected,
  actions,
  t
}: {
  job: TranscriptionJob;
  index: number;
  language: Language;
  connected: boolean;
  selected: boolean;
  actions: TranscriptionRowActions;
  t: Translate;
}) {
  const [copied, setCopied] = useState(false);
  const [requestedTarget, setRequestedTarget] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translationRequest = useRef(0);
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), []);

  const translation = job.translation ?? null;
  useEffect(() => {
    if (requestedTarget && translation?.targetLanguage === requestedTarget)
      setRequestedTarget(null);
  }, [translation?.progress, translation?.status, translation?.targetLanguage, requestedTarget]);

  const done = job.status === 'completed';
  const running = job.status === 'processing';
  const active = running || job.status === 'queued';
  const settledNotDone = isSettled(TRANSCRIPTION_LIFECYCLE, job.status) && !done;
  const sourceBase = (job.detectedLanguage ?? job.requestedLanguage)
    .replaceAll('_', '-')
    .split('-')[0]
    .toLowerCase();
  const displayedTarget = requestedTarget ?? translation?.targetLanguage ?? null;
  const targetCodes = useMemo(
    () =>
      TRANSLATEGEMMA_LANGUAGE_CODES.filter(
        code => code === displayedTarget || code.split('-')[0].toLowerCase() !== sourceBase
      ),
    [sourceBase, displayedTarget]
  );
  const awaitingRequested =
    requestedTarget !== null && requestedTarget !== translation?.targetLanguage;
  const translating =
    awaitingRequested || translation?.status === 'queued' || translation?.status === 'processing';

  const copy = async () => {
    if (await actions.copy(job.id)) {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    }
  };
  const changeTarget = (code: string) => {
    const request = ++translationRequest.current;
    setRequestedTarget(code);
    void actions.translate(job.id, code).catch(() => {
      if (translationRequest.current === request) setRequestedTarget(null);
    });
  };

  const translationLabel = awaitingRequested
    ? t('transcriptionRowTranslating')
    : translation?.status === 'completed'
      ? t('transcriptionRowTranslated')
      : translation?.status === 'failed'
        ? translation.error === 'TRANSLATION_CANCELLED'
          ? t('transcriptionRowTranslationCancelled')
          : t('transcriptionRowTranslationFailed')
        : translation?.status === 'unavailable'
          ? t('transcriptionRowTranslationUnavailable')
          : t('transcriptionRowTranslating');

  // A fast run that produced far less text than its recording could hold has probably
  // missed speech under music; the full model is the answer, and it is one click away.
  const suspiciouslyShort =
    done &&
    (job.characters ?? 0) > 0 &&
    job.quality === 'fast' &&
    (job.audibleSeconds ?? 0) > 10 &&
    (job.characters ?? 0) < SHORT_TRANSCRIPT_CHARS_PER_SECOND * (job.audibleSeconds ?? 0);

  // Finished, and nothing in it: whisper heard no speech. Said plainly, with the full
  // model one click away — a green "done" beside "0 characters" read as success.
  const silent = done && (job.characters ?? 0) === 0;

  const meta: string[] = [];
  if (job.durationSeconds) meta.push(formatDuration(job.durationSeconds));
  // The character count lives in the viewer's header; here it pushed the line onto two
  // rows on a laptop, with a lone separator starting the second.
  if (done && job.quality) {
    meta.push(
      job.quality === 'fast' ? t('transcriptionQualityFast') : t('transcriptionQualityAccurate')
    );
  }

  return (
    <article
      className={`job-row transcription-row ${selected ? 'is-selected' : ''} ${
        running ? 'is-processing' : ''
      }`.trim()}
      data-state={job.status}
      onClick={event => {
        if (job.status === 'analyzing') return;
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, label, [role="button"], [role="listbox"]')) return;
        actions.select(
          job.id,
          index,
          !selected,
          (event.nativeEvent as MouseEvent).shiftKey === true
        );
      }}
    >
      {/* First in the source so the keyboard reaches View, Copy and Export before the row's
          details; the grid puts the column back on the right. */}
      <div
        className="transcription-row-actions"
        aria-label={t('fileActions', { name: job.fileName })}
      >
        {done && (
          <>
            {/* What is done with a finished transcript, loudest first. */}
            <div className="transcription-row-actions-main">
              <Button
                variant="primary"
                onClick={event => actions.view(job.id, event.currentTarget)}
              >
                <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
                {t('transcriptionView')}
              </Button>
              <Button variant="secondary" disabled={silent} onClick={() => void copy()}>
                <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
                {copied ? t('transcriptionCopied') : t('transcriptionCopy')}
              </Button>
              <ExportMenu
                portal
                hasTimings={job.timed !== false}
                hasTranslation={translation?.status === 'completed'}
                disabled={silent}
                onExport={(format, content) => actions.export(job.id, format, content)}
                t={t}
              />
            </div>
            {/* What is done with the file itself. Named rather than left as three bare
                icons: nobody should have to hover a bin to find out it is a bin, and the
                one destructive action is the one that most needs saying out loud. The
                labels are dropped by CSS alone on a narrow card, never by a prop. */}
            <div className="transcription-row-quiet-actions">
              <Button
                variant="ghost"
                disabled={!connected}
                title={t('transcriptionRepeat')}
                // The label goes with the width; the accessible name never does.
                aria-label={t('transcriptionRepeat')}
                // The same run again: its own quality, not whatever the panel says now.
                onClick={() =>
                  job.quality ? actions.startWith(job.id, job.quality) : actions.start(job.id)
                }
              >
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="action-label">{t('transcriptionRepeatShort')}</span>
              </Button>
              {job.sourceKind === 'local' && (
                <Button
                  variant="ghost"
                  disabled={!connected}
                  title={t('showInFolder')}
                  aria-label={t('showInFolder')}
                  onClick={() => actions.reveal(job.id)}
                >
                  <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span className="action-label">{t('transcriptionRevealShort')}</span>
                </Button>
              )}
              <Button
                variant="ghost"
                className="is-destructive"
                disabled={!connected}
                title={t('transcriptionRemove')}
                aria-label={t('transcriptionRemove')}
                onClick={() => actions.remove(job.id)}
              >
                <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="action-label">{t('transcriptionRemove')}</span>
              </Button>
            </div>
          </>
        )}
        {job.status === 'ready' && (
          <div className="transcription-row-actions-main">
            <Button variant="primary" disabled={!connected} onClick={() => actions.start(job.id)}>
              <Play size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionStart')}
            </Button>
            <Button
              variant="ghost"
              className="is-destructive"
              disabled={!connected}
              title={t('transcriptionRemove')}
              aria-label={t('transcriptionRemove')}
              onClick={() => actions.remove(job.id)}
            >
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="action-label">{t('transcriptionRemove')}</span>
            </Button>
          </div>
        )}
        {active && (
          <div className="transcription-row-actions-main">
            {running && (
              <Button
                variant="secondary"
                disabled={!connected}
                onClick={() => actions.pause(job.id, !job.paused)}
              >
                {job.paused ? (
                  <Play size={16} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Pause size={16} strokeWidth={1.75} aria-hidden="true" />
                )}
                {t(job.paused ? 'jobResume' : 'jobPause')}
              </Button>
            )}
            <Button variant="danger" disabled={!connected} onClick={() => actions.cancel(job.id)}>
              <Ban size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionCancel')}
            </Button>
          </div>
        )}
        {settledNotDone && (
          <div className="transcription-row-actions-main">
            <Button variant="primary" disabled={!connected} onClick={() => actions.retry(job.id)}>
              <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionRetry')}
            </Button>
            <Button
              variant="ghost"
              className="is-destructive"
              disabled={!connected}
              title={t('transcriptionRemove')}
              aria-label={t('transcriptionRemove')}
              onClick={() => actions.remove(job.id)}
            >
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="action-label">{t('transcriptionRemove')}</span>
            </Button>
          </div>
        )}
      </div>

      <div className="transcription-row-main">
        <div className="job-row-header">
          <Checkbox
            checked={selected}
            disabled={job.status === 'analyzing'}
            aria-label={t('fileSelection', { name: job.fileName })}
            label={<span className="sr-only">{t('fileSelection', { name: job.fileName })}</span>}
            onChange={event =>
              actions.select(
                job.id,
                index,
                event.target.checked,
                (event.nativeEvent as MouseEvent | KeyboardEvent).shiftKey === true
              )
            }
          />
          <div className="transcription-row-title">
            <h3 className="job-row-name" title={job.fileName}>
              {job.fileName}
            </h3>
            <div className="transcription-row-meta">
              <RowLanguage
                job={job}
                language={language}
                connected={connected}
                actions={actions}
                t={t}
              />
              {meta.map((entry, position) => (
                <span key={position}>{entry}</span>
              ))}
            </div>
          </div>
          {running && job.paused ? (
            <span className="status-badge status-processing is-paused">
              <Pause size={11} strokeWidth={2.2} aria-hidden="true" />
              {t('jobPaused')}
            </span>
          ) : (
            <StatusBadge status={job.status} t={t} context="transcription" />
          )}
        </div>

        {done && job.preview && (
          <button
            type="button"
            className="transcription-row-snippet"
            dir={isRtlLanguage(sourceBase) ? 'rtl' : 'ltr'}
            title={t('transcriptionView')}
            aria-label={t('transcriptionOpenTranscript', { file: job.fileName })}
            onClick={event => actions.view(job.id, event.currentTarget)}
          >
            <span>{job.preview}</span>
          </button>
        )}

        {active && (
          <div className="transcription-row-progress">
            <ProgressBar
              value={job.status === 'queued' ? 0 : job.progress}
              active={running && connected && !job.paused}
              label={job.fileName}
            />
            <span className="transcription-row-progress-value">
              {job.status === 'queued'
                ? t('statusQueued')
                : job.paused
                  ? t('jobPaused')
                  : job.progress !== null
                    ? `${Math.round(job.progress)}%`
                    : t('transcriptionProcessing')}
            </span>
          </div>
        )}

        {silent && (
          <div className="transcription-row-hint" role="note">
            <span>{t('transcriptionNoSpeech')}</span>
            {job.quality === 'fast' && (
              <Button
                variant="ghost"
                disabled={!connected}
                onClick={() => actions.startWith(job.id, 'accurate')}
              >
                <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
                {t('transcriptionRetryAccurate')}
              </Button>
            )}
          </div>
        )}

        {suspiciouslyShort && (
          <div className="transcription-row-hint" role="note">
            <span>{t('transcriptionShortHint')}</span>
            <Button
              variant="ghost"
              disabled={!connected}
              onClick={() => actions.startWith(job.id, 'accurate')}
            >
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionRetryAccurate')}
            </Button>
          </div>
        )}

        {done && translation && (
          <div
            className={`transcription-row-translation is-${translation.status}`}
            data-testid="row-translation"
          >
            <div className="transcription-row-translation-line">
              <span className="transcription-row-translation-label">{translationLabel}</span>
              <LanguageCombobox
                portal
                compact
                value={displayedTarget ?? translation.targetLanguage}
                codes={targetCodes}
                language={language}
                label={t('transcriptionTranslateTo')}
                disabled={!connected}
                onChange={changeTarget}
              />
              {translation.status === 'unavailable' && (
                <Button variant="ghost" disabled={!connected} onClick={actions.installTranslator}>
                  <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t('transcriptionInstallTranslator')}
                </Button>
              )}
              {translation.status === 'processing' && translation.progress !== null && (
                <span className="transcription-row-translation-percent">
                  {Math.round(translation.progress)}%
                </span>
              )}
              {translation.status === 'failed' && !awaitingRequested && (
                <Button
                  variant="ghost"
                  disabled={!connected}
                  onClick={() => changeTarget(translation.targetLanguage)}
                >
                  <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t('transcriptionTranslationRetry')}
                </Button>
              )}
            </div>
            {translating && (
              <ProgressBar
                value={translation.progress}
                active
                label={t('transcriptionRowTranslationProgress', { file: job.fileName })}
              />
            )}
          </div>
        )}

        {settledNotDone && job.error && (
          <div className="transcription-row-error" role="alert">
            {describeError(job.error, t)}
          </div>
        )}
      </div>
    </article>
  );
});

/**
 * What language this file is in — and the one control that can fix it.
 *
 * The guess arrives in three stages: a few seconds after the file is added the probe names
 * a language, the run replaces it with its own if it reached one first, and a person can
 * overrule both. Whisper's detector is genuinely unsure inside a few language families —
 * Uzbek comes back as Azerbaijani, Turkish or Pashto — so a guess it is not confident
 * about says so, and the picker opens with those neighbours already at the top.
 */
function RowLanguage({
  job,
  language,
  connected,
  actions,
  t
}: {
  job: TranscriptionJob;
  language: Language;
  connected: boolean;
  actions: TranscriptionRowActions;
  t: Translate;
}) {
  const detected = job.detectedLanguage;
  const neighbours = useMemo(() => confusableLanguages(detected), [detected]);
  // Only a machine's guess is ever called uncertain: a low posterior, or a language whose
  // whole family the detector mixes up. A person's own answer is never second-guessed.
  const uncertain =
    detected !== null &&
    job.languageSource !== 'manual' &&
    ((job.languageConfidence !== undefined && job.languageConfidence < 0.85) ||
      neighbours.length > 0);

  if (job.languageProbing && !detected) {
    return (
      <span className="transcription-row-language is-probing">
        <span className="spinner" aria-hidden="true" />
        {t('transcriptionLanguageProbing')}
      </span>
    );
  }

  const editable = connected && job.status !== 'processing' && job.status !== 'queued';
  const picker = (
    <LanguageCombobox
      portal
      compact
      value={detected ?? 'auto'}
      codes={TRANSCRIPTION_LANGUAGE_CODES}
      pinned={neighbours}
      language={language}
      label={t('transcriptionSpokenLanguageOf', { file: job.fileName })}
      autoLabel={detected ? t('transcriptionLanguageAuto') : t('transcriptionLanguageUnknown')}
      emptyLabel={t('transcriptionLanguageNoMatch')}
      // Mid-run the answer belongs to the run: changing it here would label a file with a
      // language nothing listened for.
      disabled={!editable}
      onChange={code => actions.setLanguage(job.id, code)}
    />
  );
  return (
    <span
      className={`transcription-row-language${uncertain ? ' is-uncertain' : ''}`}
      title={job.languageSource === 'manual' ? t('transcriptionLanguageManual') : undefined}
    >
      {/* Doubt gets a shape, not just a colour: a question mark where the globe would be,
          and it wraps the picker so the mark before the name and the per cent after it both
          open what the detector actually heard. */}
      {uncertain ? (
        <LanguageDoubt
          job={job}
          language={language}
          disabled={!editable}
          onChoose={code => actions.setLanguage(job.id, code)}
          t={t}
        >
          {picker}
        </LanguageDoubt>
      ) : (
        <>
          <Globe size={14} strokeWidth={1.75} aria-hidden="true" />
          {picker}
        </>
      )}
    </span>
  );
}
