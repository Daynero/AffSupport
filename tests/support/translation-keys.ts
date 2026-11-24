import { en } from '../../apps/web/src/locales/en';
import type { TranslationKey } from '../../apps/web/src/i18n';

/**
 * Every key the dictionaries define (070 T072).
 *
 * `i18n.ts` used to export this, which kept the English dictionary in the
 * application's first chunk even for a reader who never sees English. The
 * dictionaries load per language now, so the list lives with the tests that
 * walk it.
 */
export const translationKeys = Object.keys(en) as TranslationKey[];
