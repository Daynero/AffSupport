/**
 * The counted words the accounts list says out loud — "2 agents", "1 free",
 * "3 running", "4 accounts", "2 runs".
 *
 * Ukrainian counts three ways and English two, and every one of these phrases
 * is built the same way, so the choice lives here once rather than in a
 * handful of near-identical helpers next to the components that need it.
 */

import type { Language, TranslationKey } from '../../i18n';

/**
 * The CLDR categories these phrases can land in, named as CLDR names them.
 * Ukrainian integers reach `one`, `few` and `many`; English reaches `one` and
 * `other`, which is why `other` is spelt out rather than left to a default —
 * in English `select(2)` is `other`, not `few`, and a slot nobody reads is a
 * slot nobody notices is wrong.
 */
type Forms = {
  one: TranslationKey;
  few: TranslationKey;
  many: TranslationKey;
  other: TranslationKey;
};

/**
 * One `Intl.PluralRules` per language, kept. These run for every row and every
 * account on every render, and typing in the search box re-renders the whole
 * list per keystroke; building the formatter each time was a hundred of them
 * per letter.
 */
const rules = new Map<string, Intl.PluralRules>();

function rulesFor(language: Language): Intl.PluralRules {
  const locale = language === 'uk' ? 'uk-UA' : 'en-US';
  let cached = rules.get(locale);
  if (!cached) {
    cached = new Intl.PluralRules(locale);
    rules.set(locale, cached);
  }
  return cached;
}

export function teamPluralKey(language: Language, count: number, forms: Forms): TranslationKey {
  const category = rulesFor(language).select(count);
  if (category === 'one') return forms.one;
  if (category === 'few') return forms.few;
  if (category === 'many') return forms.many;
  // `zero`, `two` and `other`: no language here has a form of its own for them.
  return forms.other;
}

/** The three-form shape both languages happen to fit: English repeats one. */
function forms(one: TranslationKey, few: TranslationKey, many: TranslationKey): Forms {
  return { one, few, many, other: many };
}

const ACCOUNTS = forms('teamAccountsCountOne', 'teamAccountsCountFew', 'teamAccountsCountMany');
const AGENTS = forms('teamAccountAgentsOne', 'teamAccountAgentsFew', 'teamAccountAgentsMany');
const FREE = forms('teamAccountFreeOne', 'teamAccountFreeFew', 'teamAccountFreeMany');
const BUSY = forms('teamAccountBusyOne', 'teamAccountBusyFew', 'teamAccountBusyMany');
const TASKS = forms('teamAgentTasksOne', 'teamAgentTasksFew', 'teamAgentTasksMany');
const RUNS = forms('teamAgentRunsOne', 'teamAgentRunsFew', 'teamAgentRunsMany');

export const accountCountKey = (language: Language, count: number) =>
  teamPluralKey(language, count, ACCOUNTS);
export const agentCountKey = (language: Language, count: number) =>
  teamPluralKey(language, count, AGENTS);
export const freeCountKey = (language: Language, count: number) =>
  teamPluralKey(language, count, FREE);
export const busyCountKey = (language: Language, count: number) =>
  teamPluralKey(language, count, BUSY);
export const taskCountKey = (language: Language, count: number) =>
  teamPluralKey(language, count, TASKS);
export const runCountKey = (language: Language, count: number) =>
  teamPluralKey(language, count, RUNS);
