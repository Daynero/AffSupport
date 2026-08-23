import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';

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
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={t('teamCatalogSearchPlaceholder')}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  );
}
