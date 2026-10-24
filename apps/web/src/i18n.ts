import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analytics } from './analytics/service';
import { en } from './locales/en';
import { uk } from './locales/uk';
import { pluralRules } from './lib/plural-rules';

export type Language = 'en' | 'uk';

export type TranslationKey = keyof typeof en;
const dictionaries = { en, uk };
export const translationKeys = Object.keys(en) as TranslationKey[];

export function detectLanguage(
  saved: string | null,
  browserLanguages: readonly string[]
): Language {
  if (saved === 'en' || saved === 'uk') return saved;
  return browserLanguages.some(value => value.toLowerCase().startsWith('uk')) ? 'uk' : 'en';
}

export function translate(
  language: Language,
  key: TranslationKey,
  values: Record<string, string | number> = {}
) {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    dictionaries[language][key]
  );
}

/**
 * Plural category for a count, from the platform's own rules.
 *
 * The hand-written version knew two forms, and Ukrainian has three: one file,
 * two files, five files. "2 файлів" was shown for every selection of two, three
 * or four — grammatically wrong, on a string a user sees every time they tick a
 * second checkbox.
 *
 * `Intl.PluralRules` is in every browser this application supports and it
 * already knows these rules for every language, including the ones we have not
 * translated into yet. Writing them out again would be reimplementing a table
 * that ships with the platform, and getting it wrong the same way.
 */
function pluralCategory(language: Language, count: number): 'one' | 'few' | 'many' {
  const category = pluralRules(language).select(count);
  if (category === 'one') return 'one';
  if (category === 'few') return 'few';
  return 'many';
}

export function fileCountKey(language: Language, count: number): TranslationKey {
  const category = pluralCategory(language, count);
  if (category === 'one') return 'chipFilesOne';
  return category === 'few' ? 'chipFilesFew' : 'chipFilesMany';
}

/** Ukrainian has three forms and the toolbar prints the number: "1 лендінгів" is not one. */
export function landingCountKey(language: Language, count: number): TranslationKey {
  const category = pluralCategory(language, count);
  if (category === 'one') return 'landingQueueCountOne';
  return category === 'few' ? 'landingQueueCountFew' : 'landingQueueCount';
}

/** 023 — "3 catalogs selected" in the updater's toolbar. */
export function catalogSelectedCountKey(language: Language, count: number): TranslationKey {
  const category = pluralCategory(language, count);
  if (category === 'one') return 'catalogUpdaterSelectedOne';
  return category === 'few' ? 'catalogUpdaterSelectedFew' : 'catalogUpdaterSelectedMany';
}

/** 023 — "12 catalogs" on the updater's chip. */
export function catalogCountKey(language: Language, count: number): TranslationKey {
  const category = pluralCategory(language, count);
  if (category === 'one') return 'catalogUpdaterChipCatalogsOne';
  return category === 'few' ? 'catalogUpdaterChipCatalogsFew' : 'catalogUpdaterChipCatalogsMany';
}

export function selectedCountKey(language: Language, count: number): TranslationKey {
  const category = pluralCategory(language, count);
  if (category === 'one') return 'selectedOne';
  return category === 'few' ? 'selectedFew' : 'selectedMany';
}

export function syncProfileLanguage(language: Language) {
  if (typeof window === 'undefined') return;
  // A choice made on this browser takes precedence over an older profile value.
  const saved = localStorage.getItem('language');
  if (saved === 'en' || saved === 'uk') language = saved;
  localStorage.setItem('language', language);
  document.documentElement.lang = language;
  analytics.setLocale(language);
  window.dispatchEvent(new CustomEvent('wishly-language-changed', { detail: language }));
}

export function useI18n() {
  const [language, update] = useState<Language>(() =>
    detectLanguage(
      typeof localStorage === 'undefined' ? null : localStorage.getItem('language'),
      typeof navigator === 'undefined'
        ? ['en']
        : navigator.languages?.length
          ? navigator.languages
          : [navigator.language]
    )
  );
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  useEffect(() => {
    const sync = (event: Event) => {
      const next =
        event instanceof CustomEvent
          ? event.detail
          : event instanceof StorageEvent
            ? event.newValue
            : null;
      if (next === 'en' || next === 'uk') update(next);
    };
    window.addEventListener('wishly-language-changed', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('wishly-language-changed', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const setLanguage = useCallback((next: Language) => {
    localStorage.setItem('language', next);
    if (languageRef.current === next) return;
    languageRef.current = next;
    update(next);
    analytics.setLocale(next);
    analytics.track('language_changed', { language: next });
    window.dispatchEvent(new CustomEvent('wishly-language-changed', { detail: next }));
  }, []);
  const t = useMemo(
    () => (key: TranslationKey, values?: Record<string, string | number>) =>
      translate(language, key, values),
    [language]
  );
  return { language, setLanguage, t };
}
