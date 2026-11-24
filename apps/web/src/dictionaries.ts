import type { en } from './locales/en';

type Language = 'en' | 'uk';
type Dictionary = Record<keyof typeof en, string>;

/**
 * The dictionaries, one per language, loaded on demand (070 T072).
 *
 * `i18n.ts` used to import both, so every visitor downloaded both — 143 kB of
 * gzip, the largest chunk in the application — to read one. Now `main.tsx`
 * loads the language the reader will see before the first render, and the other
 * arrives only if they switch to it; `translate` stays synchronous, because by
 * the time anything renders its language is here.
 *
 * A module of its own, with no imports, so the test setup can load both
 * dictionaries without pulling in what `i18n.ts` depends on (analytics, and
 * through it the Supabase client).
 */
const dictionaries: Partial<Record<Language, Dictionary>> = {};
const pending = new Map<Language, Promise<void>>();

export function isLanguageLoaded(language: Language): boolean {
  return dictionaries[language] !== undefined;
}

export function loadLanguage(language: Language): Promise<void> {
  if (dictionaries[language]) return Promise.resolve();
  let load = pending.get(language);
  if (!load) {
    load = (
      language === 'en'
        ? import('./locales/en').then(module => module.en)
        : import('./locales/uk').then(module => module.uk)
    )
      .then(dictionary => {
        dictionaries[language] = dictionary;
      })
      .finally(() => pending.delete(language));
    pending.set(language, load);
  }
  return load;
}

/**
 * The language asked for, or — while it is still on its way — whichever one is
 * here. `undefined` only if the boot could not load any dictionary at all.
 */
export function dictionaryFor(language: Language): Dictionary | undefined {
  return dictionaries[language] ?? dictionaries.en ?? dictionaries.uk;
}
