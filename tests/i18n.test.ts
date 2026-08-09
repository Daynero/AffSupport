import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  selectedCountKey,
  translate,
  translationKeys,
  type TranslationKey
} from '../apps/web/src/i18n';

const teamSourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '../apps/web/src/team');

async function teamUiSourceFiles(directory = teamSourceDirectory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? teamUiSourceFiles(path)
        : Promise.resolve(/\.tsx?$/.test(entry.name) ? [path] : []);
    })
  );
  return files.flat();
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
}

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

  it('compile-checks and renders every translation key used by the team UI', async () => {
    const declaredTeamKeys = new Set<TranslationKey>(
      translationKeys.filter((key): key is TranslationKey => key.startsWith('team'))
    );
    const usedTeamKeys = new Set<string>();
    for (const path of await teamUiSourceFiles()) {
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(/\bt\(\s*['"](team[A-Za-z0-9_]+)['"]/g)) {
        usedTeamKeys.add(match[1]);
      }
    }

    expect(usedTeamKeys.size).toBeGreaterThan(100);
    for (const key of usedTeamKeys) {
      expect(declaredTeamKeys.has(key as TranslationKey), `missing team key: ${key}`).toBe(true);
      const checkedKey = key as TranslationKey;
      const english = translate('en', checkedKey);
      const ukrainian = translate('uk', checkedKey);
      expect(english.trim(), `empty English copy: ${key}`).not.toBe('');
      expect(ukrainian.trim(), `empty Ukrainian copy: ${key}`).not.toBe('');
      expect(placeholders(ukrainian), `placeholder drift: ${key}`).toEqual(placeholders(english));
    }
  });

  it('keeps every shared-landings and previewer-interop key in English/Ukrainian parity', () => {
    const keys = translationKeys.filter(
      key =>
        key.startsWith('teamLanding') ||
        key.startsWith('teamLandings') ||
        key.startsWith('landingGalleryTeam')
    );
    expect(keys.length).toBeGreaterThan(25);
    for (const key of keys) {
      const english = translate('en', key);
      const ukrainian = translate('uk', key);
      expect(english.trim(), `empty English copy: ${key}`).not.toBe('');
      expect(ukrainian.trim(), `empty Ukrainian copy: ${key}`).not.toBe('');
      expect(placeholders(ukrainian), `placeholder drift: ${key}`).toEqual(placeholders(english));
    }
  });

  it('offers explicit Mac and Windows installation choices', () => {
    expect(translate('en', 'macAppleSilicon')).toBe('Mac (Apple Silicon)');
    expect(translate('uk', 'macAppleSilicon')).toBe('Mac (Apple Silicon)');
    expect(translate('en', 'windows')).toBe('Windows');
    expect(translate('uk', 'windowsComingSoonBody')).toContain('ще в розробці');
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
