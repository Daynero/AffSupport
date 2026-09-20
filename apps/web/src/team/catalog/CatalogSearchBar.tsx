import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';
import { Search } from 'lucide-react';
import { Input } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';

/**
 * The catalog's search field.
 *
 * `/` focuses it, the way it does in every tool people already use for this.
 * The listener is scoped to this component rather than a global shortcut
 * registry: there is exactly one search field on screen at a time, and a
 * registry for a single binding would be more machinery than behaviour.
 */
export function CatalogSearchBar({
  value,
  onChange,
  autoFocus = false
}: {
  value: string;
  onChange: (value: string) => void;
  /** Take the keyboard on mount — the explorer opens this bar on purpose. */
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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

  return (
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
      />
    </label>
  );
}
