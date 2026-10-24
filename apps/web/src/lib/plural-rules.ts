import type { Language } from '../i18n';

const rules = new Map<Language, Intl.PluralRules>();

/** Reuse formatters across counts rendered in the same language. */
export function pluralRules(language: Language): Intl.PluralRules {
  let value = rules.get(language);
  if (!value) {
    value = new Intl.PluralRules(language);
    rules.set(language, value);
  }
  return value;
}
