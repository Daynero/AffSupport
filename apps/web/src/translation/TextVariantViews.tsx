import { Check, Copy } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import {
  Button,
  DropdownMenu,
  Progress,
  Tabs,
  Tooltip,
  type TabItem
} from '../components/ui/index';
import { ICON_STROKE } from '../components/icons';
import { useI18n, type Language } from '../i18n';
import { isRtlLanguage, languageDisplayName } from '../transcription/language';
import { TranslateLauncher } from './TranslateLauncher';
import { trackTranslation } from './analytics';
import type { TextVariant, TextVariantsState, TranslationVariant } from './useTextVariants';

export function variantName(
  variant: TextVariant,
  language: Language,
  originalLabel: string
): string {
  if (variant.kind === 'original') {
    // "auto", "und" or a word like "unknown" names no language: the label stays plain.
    return variant.language &&
      /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(variant.language) &&
      !['und', 'auto'].includes(variant.language.toLowerCase())
      ? `${originalLabel} · ${variant.language.toUpperCase()}`
      : originalLabel;
  }
  return languageDisplayName(variant.language, language);
}

/** The texts a person can switch between: the original, then translations in the order made. */
export function selectableVariants(state: TextVariantsState): TextVariant[] {
  return [
    state.original,
    ...state.translations.filter(item => item.status === 'ready' || item.status === 'processing')
  ];
}

export function variantText(variant: TextVariant): string | null {
  if (variant.kind === 'original') return variant.rawText ?? variant.segments.join('\n');
  return variant.status === 'ready' && variant.segments ? variant.segments.join('\n') : null;
}

/**
 * The row of texts at the top of a viewer (063, FR-030): one marker travels to the chosen one,
 * a translation still running carries a small ring, an outdated one a dot that says why.
 */
export function TextVariantTabs({
  state,
  value,
  onChange,
  scope
}: {
  state: TextVariantsState;
  value: string;
  onChange: (key: string) => void;
  scope: 'team_video' | 'personal';
}) {
  const { t, language } = useI18n();
  const prefix = useId().replace(/[^A-Za-z0-9]/gu, '');
  const variants = selectableVariants(state);
  const items: TabItem<string>[] = variants.map(variant => {
    const name = variantName(variant, language, t('textTranslationOriginal'));
    const running = variant.kind === 'translation' && variant.status === 'processing';
    const stale = variant.kind === 'translation' && variant.status === 'ready' && variant.stale;
    return {
      id: `${prefix}-${variant.key.replace(/[^A-Za-z0-9-]/gu, '-')}`,
      label: name,
      badge: running ? (
        <Progress
          circular
          size="sm"
          color="secondary"
          value={Math.round((variant.completedSegments / Math.max(1, variant.totalSegments)) * 100)}
          label={t('textTranslationInProgress', { language: name })}
        />
      ) : stale ? (
        <Tooltip label={t('textTranslationStale')}>
          <span
            className="text-variant-stale-dot"
            role="img"
            aria-label={t('textTranslationStale')}
          />
        </Tooltip>
      ) : undefined
    };
  });
  const idFor = (key: string) => `${prefix}-${key.replace(/[^A-Za-z0-9-]/gu, '-')}`;
  const keyFor = (id: string) =>
    variants.find(variant => idFor(variant.key) === id)?.key ?? 'original';
  return (
    <div className="text-variant-tabs">
      <Tabs
        value={idFor(value)}
        items={items}
        onChange={id => {
          const key = keyFor(id);
          onChange(key);
          const chosen = variants.find(variant => variant.key === key);
          if (chosen?.kind === 'translation') {
            trackTranslation({
              action: 'opened',
              scope,
              targetLanguage: chosen.language,
              translationId: chosen.translationId
            });
          }
        }}
        label={t('textTranslationVariants')}
        variant="pill"
        size="sm"
      />
      <TranslateLauncher
        state={state}
        trigger="icon"
        onOpenTranslation={language => onChange(`translation:${language}`)}
        onStarted={language => onChange(`translation:${language}`)}
      />
    </div>
  );
}

/** A text read as text: one paragraph per segment, the language's own direction (FR-031). */
export function TextVariantReader({
  variant,
  activeIndex,
  onSegmentClick,
  className
}: {
  variant: TextVariant;
  /** The segment playing now, in a viewer with a player. */
  activeIndex?: number | null;
  /** A paragraph was clicked: the viewer seeks its player there. */
  onSegmentClick?: (index: number) => void;
  className?: string;
}) {
  const segments = variant.kind === 'original' ? variant.segments : (variant.segments ?? []);
  const language = variant.language ?? undefined;
  return (
    <div
      className={['text-variant-reader', className].filter(Boolean).join(' ')}
      lang={language}
      dir={language && isRtlLanguage(language) ? 'rtl' : 'auto'}
    >
      {segments.map((segment, index) =>
        segment ? (
          <p
            key={index}
            className={index === activeIndex ? 'is-active' : undefined}
            data-segment={index}
            onClick={onSegmentClick ? () => onSegmentClick(index) : undefined}
          >
            {segment}
          </p>
        ) : null
      )}
    </div>
  );
}

/**
 * Copy (FR-032/FR-033): one text is copied at once; with several, a short list asks which,
 * and choosing one copies it. The word on the button changes; nothing moves.
 */
export function CopyVariantButton({
  state,
  only,
  scope,
  size = 'sm',
  variant: buttonVariant = 'outline',
  label,
  ariaLabel,
  onCopied
}: {
  state: TextVariantsState;
  /** Copy this one text instead of offering the list. */
  only?: TextVariant;
  scope: 'team_video' | 'personal';
  size?: 'sm' | 'md';
  variant?: 'outline' | 'ghost';
  label?: string;
  /** The accessible name, when the visible label is shortened. */
  ariaLabel?: string;
  onCopied?: (variant: TextVariant, name: string) => void;
}) {
  const { t, language } = useI18n();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const choices = only
    ? [only]
    : [state.original, ...state.translations.filter(item => item.status === 'ready')];
  const copy = async (choice: TextVariant) => {
    const text = variantText(choice);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
    const name = variantName(choice, language, t('textTranslationOriginal'));
    onCopied?.(choice, name);
    if (choice.kind === 'translation') {
      trackTranslation({
        action: 'copied',
        scope,
        targetLanguage: choice.language,
        translationId: choice.translationId
      });
    }
  };
  return (
    <>
      <Button
        ref={anchor}
        color="neutral"
        variant={buttonVariant}
        size={size}
        aria-label={ariaLabel}
        aria-haspopup={choices.length > 1 ? 'menu' : undefined}
        aria-expanded={choices.length > 1 ? open : undefined}
        leading={
          copied ? (
            <Check size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          ) : (
            <Copy size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          )
        }
        onClick={() => (choices.length > 1 ? setOpen(value => !value) : void copy(choices[0]!))}
      >
        {copied ? t('textTranslationCopiedShort') : (label ?? t('textTranslationCopy'))}
      </Button>
      {choices.length > 1 && (
        <DropdownMenu
          open={open}
          onClose={() => setOpen(false)}
          anchor={anchor}
          label={t('textTranslationCopy')}
          items={choices.map(choice => ({
            id: choice.key,
            label: variantName(choice, language, t('textTranslationOriginal')),
            ...(choice.kind === 'translation' && choice.stale
              ? { note: t('textTranslationStale') }
              : {}),
            onSelect: () => void copy(choice)
          }))}
        />
      )}
    </>
  );
}

export function isTranslation(variant: TextVariant | undefined): variant is TranslationVariant {
  return variant?.kind === 'translation';
}
