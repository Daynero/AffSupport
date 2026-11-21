import {
  sameTranslationLanguage,
  TRANSLATION_TARGET_LANGUAGES,
  TRANSLATION_DAILY_UNITS_DEFAULT
} from '@video-compressor/shared';
import { Languages, Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Alert, Button, IconButton, Popover, Spinner, Tooltip } from '../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { LanguageCombobox } from '../transcription/LanguageCombobox';
import { languageDisplayName } from '../transcription/language';
import { allowanceFigures, formatMinutes, formatResetTime } from './format';
import { failureText } from './TranslationProgress';
import { readRecentTargets, type TextVariantsState } from './useTextVariants';

/** The first recent language that is neither the source nor already translated. */
function defaultTarget(
  source: string | null,
  recents: readonly string[],
  done: readonly string[] = []
): string {
  const usable = (code: string) => !sameTranslationLanguage(source, code) && !done.includes(code);
  return recents.find(usable) ?? ['uk', 'en', 'ru', 'es'].find(usable) ?? 'uk';
}

/**
 * Choosing a language and seeing what it costs, in one small surface (063, FR-002/FR-012/FR-013).
 * When the text does not fit, there is no button that would do nothing — only the numbers and
 * when the allowance renews.
 */
export function TranslateLauncher({
  state,
  trigger = 'icon',
  onOpenTranslation,
  onStarted,
  className
}: {
  state: TextVariantsState;
  /** `icon`: the "+" at the end of a row of texts; `button`: "Translate" with an icon. */
  trigger?: 'icon' | 'button' | 'compact';
  /** A finished translation in the chosen language already exists: show it. */
  onOpenTranslation: (language: string) => void;
  onStarted?: (language: string) => void;
  className?: string;
}) {
  const { t, language } = useI18n();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const recents = useMemo(() => (open ? readRecentTargets() : []), [open]);
  const source = state.original.language;
  const [target, setTarget] = useState(() => defaultTarget(source, readRecentTargets()));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    setFailure(null);
    setTarget(
      defaultTarget(
        source,
        recents,
        state.translations.map(item => item.language)
      )
    );
    void state.refreshAllowance();
  }, [open]);

  const codes = useMemo(
    () => TRANSLATION_TARGET_LANGUAGES.filter(code => !sameTranslationLanguage(source, code)),
    [source]
  );
  const existing = state.translations.find(item => item.language === target);
  const running = state.running.get(target);
  const ready = existing?.status === 'ready' && !existing.stale;
  const allowance = state.allowance;
  const figures = allowanceFigures(
    state.units,
    allowance?.usedUnits ?? 0,
    allowance?.limitUnits ?? TRANSLATION_DAILY_UNITS_DEFAULT
  );
  const minutes = (value: number) => formatMinutes(value, language);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const outcome = await state.start(target);
    setBusy(false);
    if (outcome.ok) {
      setOpen(false);
      onStarted?.(target);
      return;
    }
    if (outcome.code !== 'TRANSLATION_ALLOWANCE_EXCEEDED') {
      setFailure(outcome.code);
    }
  };

  let body;
  if (running) {
    body = (
      <p className="translate-launcher-line" role="status">
        <Spinner />
        {t('textTranslationInProgress', { language: languageDisplayName(target, language) })}
      </p>
    );
  } else if (ready) {
    body = (
      <div className="translate-launcher-row">
        <span className="translate-launcher-line">{t('textTranslationExists')}</span>
        <Button
          color="secondary"
          variant="soft"
          size="sm"
          onClick={() => {
            setOpen(false);
            onOpenTranslation(target);
          }}
        >
          {t('textTranslationOpen')}
        </Button>
      </div>
    );
  } else if (failure === 'TRANSLATION_UNAVAILABLE' || (state.allowanceError && !allowance)) {
    body = (
      <Alert color="neutral" variant="soft" live="status">
        {t('textTranslationUnavailable')}
      </Alert>
    );
  } else if (!allowance) {
    body = (
      <p className="translate-launcher-line">
        <Spinner />
      </p>
    );
  } else if (!figures.fits) {
    body = (
      <Alert color="warning" variant="soft" live="status">
        {figures.overDaily
          ? t('textTranslationTooLong', {
              need: minutes(figures.need),
              limit: minutes(figures.limit)
            })
          : t('textTranslationShort', {
              need: minutes(figures.need),
              left: minutes(figures.left),
              time: formatResetTime(allowance.resetsAt, language)
            })}
      </Alert>
    );
  } else {
    body = (
      <>
        {failure && (
          <Alert color="neutral" variant="soft" live="status">
            {t(failureText(failure))}
          </Alert>
        )}
        <div className="translate-launcher-row">
          <Tooltip label={t('textTranslationMinuteHint')}>
            <span className="translate-launcher-cost" tabIndex={0}>
              {t('textTranslationCost', {
                need: minutes(figures.need),
                left: minutes(figures.left),
                limit: minutes(figures.limit)
              })}
            </span>
          </Tooltip>
          <Button
            color="primary"
            variant="solid"
            size="sm"
            loading={busy}
            onClick={() => void confirm()}
          >
            {stale(existing)
              ? t('textTranslationRefresh', { need: minutes(figures.need) })
              : t('textTranslationAction')}
          </Button>
        </div>
      </>
    );
  }

  const triggerNode =
    trigger === 'icon' ? (
      <IconButton
        ref={anchor}
        label={t('textTranslationAnother')}
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
    ) : (
      <Button
        ref={anchor}
        color="neutral"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-label={trigger === 'compact' ? t('textTranslationAction') : undefined}
        title={trigger === 'compact' ? t('textTranslationAction') : undefined}
        leading={<Languages size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        onClick={() => setOpen(value => !value)}
      >
        {trigger === 'compact' ? null : t('textTranslationAction')}
      </Button>
    );

  return (
    <span className={['translate-launcher', className].filter(Boolean).join(' ')}>
      {triggerNode}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-end"
        label={t('textTranslationLanguageLabel')}
        className="translate-launcher-surface"
      >
        <div className="translate-launcher-body">
          <span id={labelId} className="translate-launcher-label">
            {t('textTranslationLanguageLabel')}
          </span>
          <LanguageCombobox
            value={target}
            codes={codes}
            language={language}
            label={t('textTranslationLanguageLabel')}
            ariaLabelledBy={labelId}
            pinned={recents.filter(code => codes.includes(code as (typeof codes)[number]))}
            emptyLabel={t('textTranslationSearchEmpty')}
            onChange={code => {
              setTarget(code);
              setFailure(null);
            }}
          />
          {body}
        </div>
      </Popover>
    </span>
  );
}

function stale(variant: { status: string; stale: boolean } | undefined): boolean {
  return variant?.status === 'ready' && variant.stale;
}
