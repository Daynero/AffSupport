import { describe, expect, it } from 'vitest';
import { detectLanguage, translate, type TranslationKey } from '../apps/web/src/i18n';

describe('language selection', () => {
  it('uses a saved choice before browser languages', () => {
    expect(detectLanguage('en', ['uk-UA'])).toBe('en');
    expect(detectLanguage('uk', ['en-US'])).toBe('uk');
  });
  it('defaults Ukrainian browsers to Ukrainian and others to English', () => {
    expect(detectLanguage(null, ['uk-UA', 'en'])).toBe('uk');
    expect(detectLanguage(null, ['de-DE'])).toBe('en');
  });
  it('contains both translations for representative UI states', () => {
    const keys: TranslationKey[] = ['agentConnected','agentDisconnected','onboardingTitle','blockedTitle','genericError','installationHelp'];
    for (const key of keys) { expect(translate('en', key)).not.toBe(key); expect(translate('uk', key)).not.toBe(key); expect(translate('en', key)).not.toBe(translate('uk', key)); }
  });
});
