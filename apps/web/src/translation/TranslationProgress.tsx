import { Languages, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Progress } from '../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n, type TranslationKey } from '../i18n';
import { languageDisplayName } from '../transcription/language';
import type { TranslationVariant } from './useTextVariants';

const FAILURE_TEXT: Record<string, TranslationKey> = {
  TRANSLATION_REFUSED: 'textTranslationRefused',
  TRANSLATION_UNAVAILABLE: 'textTranslationUnavailable',
  TRANSLATION_TIMEOUT: 'textTranslationTimedOut',
  TRANSLATION_FAILED: 'textTranslationFailed'
};

export function failureText(code: string | null): TranslationKey {
  return FAILURE_TEXT[code ?? ''] ?? 'textTranslationFailed';
}

/**
 * How far the bar shows: never behind what the server confirmed, and between confirmations it
 * keeps moving towards the next one, slowing as it nears it, so a single long chunk does not
 * read as a frozen bar. It never goes back and never claims the last stretch before the result.
 */
export function useSmoothProgress(real: number, done: boolean): number {
  const [shown, setShown] = useState(real);
  const realRef = useRef(real);
  realRef.current = real;
  useEffect(() => {
    if (done) {
      setShown(1);
      return;
    }
    setShown(value => Math.max(value, real));
    const timer = window.setInterval(() => {
      setShown(value => {
        const ceiling = Math.min(0.92, realRef.current + 0.34);
        const next = value + (ceiling - value) * 0.08;
        return Math.max(value, realRef.current, Math.min(ceiling, next));
      });
    }, 400);
    return () => window.clearInterval(timer);
  }, [done, real]);
  return shown;
}

/**
 * The strip a running or failed translation stands in (063, FR-020/FR-023). A refusal is not a
 * fault, so nothing here is red: the words say what happened and that the minutes came back.
 */
export function TranslationProgress({
  variant,
  onRetry,
  compact = false
}: {
  variant: TranslationVariant;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const { t, language } = useI18n();
  const name = languageDisplayName(variant.language, language);
  const real = variant.totalSegments > 0 ? variant.completedSegments / variant.totalSegments : 0;
  const shown = useSmoothProgress(real, variant.status === 'ready');
  const percent = Math.round(shown * 100);
  // Read out in quarters, not every percent.
  const quarter = Math.floor(percent / 25);

  if (variant.status === 'failed') {
    return (
      <div
        className={`translation-progress is-failed${compact ? ' is-compact' : ''}`}
        role="status"
      >
        <Languages size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="translation-progress-text">
          <strong>{name}</strong> · {t(failureText(variant.failureCode))}
        </span>
        {onRetry && (
          <Button
            size="sm"
            color="neutral"
            variant="ghost"
            leading={<RotateCcw size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            onClick={onRetry}
          >
            {t('textTranslationRetry')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`translation-progress${compact ? ' is-compact' : ''}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="translation-progress-head">
        <Languages size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="translation-progress-text">
          {t('textTranslationInProgress', { language: name })}
        </span>
        <span className="translation-progress-percent" aria-hidden="true">
          {percent}%
        </span>
      </div>
      <Progress
        value={percent}
        size="sm"
        color="secondary"
        label={t('textTranslationInProgress', { language: name })}
        valueText={`${quarter * 25}%`}
      />
    </div>
  );
}
