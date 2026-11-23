import { describe, expect, it } from 'vitest';
import { en } from '../apps/web/src/locales/en';
import { uk } from '../apps/web/src/locales/uk';
import type { TranslationKey } from '../apps/web/src/i18n';
import { teamErrorMessage } from '../apps/web/src/team/errors';

/**
 * 047 T054: the catalog and re-stitch failures a person meets while preparing a
 * catalog say what to do next, in both languages, and a refused or missing
 * source is never described as a broken file.
 */
const LOCALES = { en, uk } as const;
const say = (locale: keyof typeof LOCALES) => (key: TranslationKey) =>
  LOCALES[locale][key as keyof typeof en];

/** Each code with the action its sentence must carry, per locale. */
const ACTIONABLE: Record<string, { en: RegExp; uk: RegExp }> = {
  // pool exhausted
  RESTITCH_POOL_EMPTY: { en: /Open the space settings/u, uk: /Відкрийте налаштування простору/u },
  RESTITCH_SCREEN_CANDIDATES_EXHAUSTED: {
    en: /Add different images/u,
    uk: /Додайте інші картинки/u
  },
  // missing source
  RESTITCH_SCREEN_UNAVAILABLE: { en: /Choose another picture/u, uk: /Оберіть іншу картинку/u },
  RESTITCH_LOCAL_IMAGE_MISSING: { en: /Add it again/u, uk: /Додайте його знову/u },
  IMAGE_SOURCE_UNAVAILABLE: { en: /select it again/u, uk: /оберіть його повторно/u },
  // rights
  RESTITCH_SOURCE_FORBIDDEN: { en: /Ask the owner/u, uk: /Попросіть у власника/u },
  // network
  RESTITCH_SCREEN_FETCH_FAILED: { en: /Check the connection/u, uk: /Перевірте зʼєднання/u },
  RESTITCH_AGENT_UNAVAILABLE: { en: /Restore the connection/u, uk: /Відновіть зв’язок/u },
  // disk
  DISK_FULL: { en: /Free some space/u, uk: /Звільніть місце/u }
};

/** Refusals and missing sources: the file itself is fine, so never call it broken. */
const NOT_BROKEN = [
  'RESTITCH_SOURCE_FORBIDDEN',
  'RESTITCH_SCREEN_UNAVAILABLE',
  'RESTITCH_SCREEN_FETCH_FAILED',
  'RESTITCH_LOCAL_IMAGE_MISSING',
  'IMAGE_SOURCE_UNAVAILABLE',
  'IMAGE_SOURCE_CHANGED',
  'SOURCE_CHANGED'
];

describe('catalog failure messages', () => {
  for (const locale of ['en', 'uk'] as const) {
    const t = say(locale);
    const generic = t('teamErrorUnknown');

    it(`${locale}: each failure has its own sentence with a next step`, () => {
      for (const [code, action] of Object.entries(ACTIONABLE)) {
        const text = teamErrorMessage(code, t);
        expect(text, code).not.toBe(generic);
        expect(text, code).toMatch(action[locale]);
        // A fact and then an action: one bare statement is not help.
        expect(text.split(/[.!?](?:\s|$)/u).filter(Boolean).length, code).toBeGreaterThan(1);
      }
    });

    it(`${locale}: a refused or missing source is not called a broken file`, () => {
      for (const code of NOT_BROKEN) {
        const text = teamErrorMessage(code, t);
        expect(text, code).not.toBe(generic);
        expect(text, code).not.toMatch(/damaged|corrupt|broken|пошкодж|зіпсов|бит/iu);
      }
    });
  }

  it('an unknown code never reaches the screen as raw text', () => {
    expect(teamErrorMessage('RESTITCH_SOMETHING_NEW', say('en'))).toBe(en.teamErrorUnknown);
  });
});
