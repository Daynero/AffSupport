import {
  sameTranslationLanguage,
  translationPrice,
  TRANSLATION_TARGET_LANGUAGES
} from '@video-compressor/shared';
import { Languages, Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Alert, Button, IconButton, Popover, Spinner } from '../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { creditsCountKey, useI18n } from '../i18n';
import { LanguageCombobox } from '../transcription/LanguageCombobox';
import { languageDisplayName } from '../transcription/language';
import { kyivTime, refreshCredits, useCredits } from '../credits/store';
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
 * 064: the cost is in credits, on the button itself («Перекласти · 3»), and exactly that is
 * charged. When the credits do not cover it, there is no button that would do nothing — only how
 * many are missing and when they renew.
 */
export function TranslateLauncher({
  state,
  trigger = 'icon',
  onOpenTranslation,
  onStarted,
  block = false,
  className
}: {
  state: TextVariantsState;
  /** `icon`: the "+" at the end of a row of texts; `button`: "Translate" with an icon. */
  trigger?: 'icon' | 'button';
  /** A finished translation in the chosen language already exists: show it. */
  onOpenTranslation: (language: string) => void;
  onStarted?: (language: string) => void;
  /** Fills its grid cell. */
  block?: boolean;
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
    void refreshCredits();
  }, [open]);

  const codes = useMemo(
    () => TRANSLATION_TARGET_LANGUAGES.filter(code => !sameTranslationLanguage(source, code)),
    [source]
  );
  const existing = state.translations.find(item => item.language === target);
  const running = state.running.get(target);
  const ready = existing?.status === 'ready' && !existing.stale;
  // 064: the price in credits, known before pressing and charged exactly.
  const credits = useCredits();
  const price = translationPrice(state.units, target);
  const balance = credits.status;
  const short = balance ? Math.max(0, price - balance.available) : 0;

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
    if (outcome.code !== 'INSUFFICIENT_CREDITS') {
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
  } else if (failure === 'TRANSLATION_UNAVAILABLE' || (credits.error && !balance)) {
    body = (
      <Alert color="neutral" variant="soft" live="status">
        {t('textTranslationUnavailable')}
      </Alert>
    );
  } else if (!balance) {
    body = (
      <p className="translate-launcher-line">
        <Spinner />
      </p>
    );
  } else if (short > 0 || !balance.paidOpen) {
    body = (
      <Alert color="warning" variant="soft" live="status">
        {!balance.paidOpen
          ? t('aiMonthExhausted')
          : t('assistantShort', { missing: short, time: kyivTime(balance.resetsAt, language) })}
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
          <span className="translate-launcher-cost">
            {t(creditsCountKey(language, balance.available), { count: balance.available })}
          </span>
          <Button
            color="primary"
            variant="solid"
            size="sm"
            loading={busy}
            onClick={() => void confirm()}
          >
            {t('textTranslatePrice', { price })}
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
        block={block}
        color="neutral"
        variant="outline"
        size="sm"
        aria-expanded={open}
        leading={<Languages size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        onClick={() => setOpen(value => !value)}
      >
        {state.units > 0 ? t('textTranslatePrice', { price }) : t('textTranslationAction')}
      </Button>
    );

  return (
    <span
      className={['translate-launcher', block ? 'is-block' : null, className]
        .filter(Boolean)
        .join(' ')}
    >
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
