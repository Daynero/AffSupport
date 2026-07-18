import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  selectedCountKey,
  translate,
  translationKeys
} from '../apps/web/src/i18n';

describe('language selection and dictionaries', () => {
  it('uses a saved choice before browser languages', () => {
    expect(detectLanguage('en', ['uk-UA'])).toBe('en');
    expect(detectLanguage('uk', ['en-US'])).toBe('uk');
  });

  it('defaults Ukrainian browsers to Ukrainian and others to English', () => {
    expect(detectLanguage(null, ['uk-UA', 'en'])).toBe('uk');
    expect(detectLanguage(null, ['de-DE'])).toBe('en');
  });

  it('contains English and Ukrainian text for every UI key', () => {
    expect(translationKeys.length).toBeGreaterThan(100);
    for (const key of translationKeys) {
      expect(translate('en', key).trim()).not.toBe('');
      expect(translate('uk', key).trim()).not.toBe('');
    }
  });

  it('uses platform-neutral text in the web interface', () => {
    const visibleText = translationKeys
      .flatMap(key => [translate('en', key), translate('uk', key)])
      .join(' ');
    expect(visibleText).not.toMatch(/\bMac\b|macOS|Apple Silicon/i);
    expect(translate('en', 'processedLocally')).toBe('Videos are processed on your computer.');
    expect(translate('uk', 'processedLocally')).toBe('Відео обробляються на вашому комп’ютері.');
  });

  it('formats timer/status/tooltip text in both languages', () => {
    for (const key of [
      'statusProcessing',
      'ongoingTimer',
      'frameRateTooltip',
      'dropTitle',
      'invalidBitrate'
    ] as const) {
      expect(translate('en', key)).not.toBe(translate('uk', key));
    }
    expect(translate('uk', 'ongoingTimer', { time: '00:01:24' })).toBe('Триває 00:01:24');
    expect(translate('en', 'ongoingTimer', { time: '00:01:24' })).toBe('Running 00:01:24');
  });

  it('uses predictable localized selection plurals', () => {
    expect(selectedCountKey('en', 1)).toBe('selectedOne');
    expect(selectedCountKey('en', 2)).toBe('selectedMany');
    expect(selectedCountKey('uk', 21)).toBe('selectedOne');
    expect(selectedCountKey('uk', 11)).toBe('selectedMany');
  });
});
