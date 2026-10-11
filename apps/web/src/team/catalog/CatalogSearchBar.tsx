import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n';
import { History, Search } from 'lucide-react';
import { Button, Chip, Input } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import type { RecentQuery } from '../palette/recent';

/**
 * The catalog's search field.
 *
 * `/` focuses it, the way it does in every tool people already use for this.
 * The listener is scoped to this component rather than a global shortcut
 * registry: there is exactly one search field on screen at a time, and a
 * registry for a single binding would be more machinery than behaviour.
 *
 * With the field empty, the searches used lately sit under it as chips
 * (search rework, 2026-10) — always there rather than in a dropdown that
 * appears on focus, so nothing jumps in under the pointer and the way back to
 * yesterday's query is visible before anyone thinks to look for it. Down
 * from the field walks into them; Enter applies one, Delete forgets it.
 */
export function CatalogSearchBar({
  value,
  onChange,
  autoFocus = false,
  onFieldKeyDown,
  history = [],
  onApplyHistory,
  onForgetHistory,
  onClearHistory
}: {
  value: string;
  onChange: (value: string) => void;
  /** Take the keyboard on mount — the explorer opens this bar on purpose. */
  autoFocus?: boolean;
  /** The results' keys (arrows, Enter, Escape), handled by whoever owns the results. */
  onFieldKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  history?: readonly RecentQuery[];
  onApplyHistory?: (entry: RecentQuery) => void;
  onForgetHistory?: (entry: RecentQuery) => void;
  onClearHistory?: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const showHistory = value.trim() === '' && history.length > 0 && Boolean(onApplyHistory);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      // Never steal the key from someone typing — including from this field.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const chipButtons = () =>
    Array.from(
      historyRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-history-chip] .ui-chip-press'
      ) ?? []
    );

  const focusChip = (index: number) => {
    const buttons = chipButtons();
    if (buttons.length === 0 || index < 0) {
      inputRef.current?.focus();
      return;
    }
    buttons[Math.min(index, buttons.length - 1)]?.focus();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (showHistory && event.key === 'ArrowDown') {
      event.preventDefault();
      focusChip(0);
      return;
    }
    onFieldKeyDown?.(event);
  };

  const onHistoryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = chipButtons();
    const index = buttons.findIndex(button => button === document.activeElement);
    if (index < 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusChip(Math.min(buttons.length - 1, index + 1));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusChip(index - 1);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      const entry = history[index];
      if (!entry) return;
      onForgetHistory?.(entry);
      // The neighbour takes the focus, or the field when the list is gone.
      window.requestAnimationFrame(() => focusChip(history.length > 1 ? index : -1));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      inputRef.current?.focus();
    }
  };

  return (
    <div className="team-catalog-search-block">
      <label className="team-catalog-search">
        <span>{t('teamCatalogSearch')}</span>
        {/* The inventory's field, with the glass that says what it is for
            (021, T097). */}
        <Input
          ref={inputRef}
          type="search"
          value={value}
          placeholder={t('teamCatalogSearchPlaceholder')}
          leading={<Search size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          onChange={event => onChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          enterKeyHint="search"
          autoComplete="off"
        />
      </label>
      {showHistory && (
        <div
          ref={historyRef}
          className="team-catalog-history"
          role="group"
          aria-label={t('searchHistoryTitle')}
          onKeyDown={onHistoryKeyDown}
        >
          <span className="team-catalog-history-label" title={t('searchHistoryTitle')}>
            <History size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="sr-only">{t('searchHistoryTitle')}</span>
          </span>
          <ul className="team-catalog-history-list">
            {history.map(entry => (
              <li key={entry.query} data-history-chip>
                <Chip
                  size="sm"
                  variant="outline"
                  title={
                    entry.scope === 'folder'
                      ? t('searchHistoryInFolder')
                      : t('searchHistoryInSpace')
                  }
                  onSelect={() => {
                    onApplyHistory?.(entry);
                    // Back to the field: the next key is Enter, an arrow, or more words.
                    inputRef.current?.focus();
                  }}
                  onRemove={onForgetHistory ? () => onForgetHistory(entry) : undefined}
                  removeLabel={t('searchHistoryForget', { query: entry.query })}
                >
                  {entry.query}
                </Chip>
              </li>
            ))}
          </ul>
          {onClearHistory && (
            <Button type="button" variant="link" size="xs" onClick={onClearHistory}>
              {t('searchHistoryClear')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
