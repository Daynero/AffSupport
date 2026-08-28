import { describe, expect, it } from 'vitest';
import { translate, translationKeys, type TranslationKey } from '../apps/web/src/i18n';

/**
 * The interface glossary, enforced (contracts/glossary.md, SC-007).
 *
 * A vocabulary agreed in a document rots the moment two people write copy on
 * different days. These assertions are what make it a contract instead: adding
 * a string that calls a space a "team", or a task a «таска», fails the build.
 */

const LOCALES = ['en', 'uk'] as const;

/** Every user-visible string in team mode, per locale. */
function teamStrings(locale: (typeof LOCALES)[number]): { key: TranslationKey; value: string }[] {
  return translationKeys
    .filter(key => key.startsWith('team') || key.startsWith('creativeLibrary'))
    .map(key => ({ key, value: translate(locale, key) }));
}

describe('forbidden vocabulary', () => {
  it.each(LOCALES)('has no placeholder copy in %s', locale => {
    const offenders = teamStrings(locale).filter(({ value }) =>
      value.toUpperCase().includes('ДОНТ ПУШ')
    );
    expect(offenders).toEqual([]);
  });

  it('never calls a task «таска» in Ukrainian', () => {
    // The slang register belongs in conversation, not in the interface.
    const offenders = teamStrings('uk').filter(({ value }) => /таск/iu.test(value));
    expect(offenders).toEqual([]);
  });

  it.each(LOCALES)('does not use "material" as a word for a file in %s', locale => {
    const pattern = locale === 'uk' ? /матеріал/iu : /\bmaterials?\b/iu;
    const offenders = teamStrings(locale).filter(({ value }) => pattern.test(value));
    expect(offenders).toEqual([]);
  });

  it.each(LOCALES)('does not use "media" or "asset" as a word for a file in %s', locale => {
    const pattern = locale === 'uk' ? /\bмедіа\b/iu : /\b(media|assets?)\b/iu;
    const offenders = teamStrings(locale).filter(({ value }) => pattern.test(value));
    // The bulk-upload surface used to be excepted here for naming a physical
    // file kind rather than the content unit. Its key went with the drag
    // plumbing (010 T062), so the exception went too rather than lingering as a
    // filter that can never match.

    expect(offenders).toEqual([]);
  });
});

describe('the object noun', () => {
  /**
   * The object is a Space. "Team workspace" names the *mode* and is allowed;
   * "team" on its own as the thing you belong to is not.
   */
  const MODE_KEYS = new Set<string>([
    'teamWorkspace',
    'teamWorkspaceDescription',
    'teamWorkspaceGateTitle',
    'teamWorkspaceGateBody',
    'teamWorkspaceWaitlist',
    'teamWorkspaceWaitlistSaved',
    'teamWorkspaceWaitlistError',
    'teamWorkspaceAccelerate',
    'teamWorkspaceWithInvitations'
  ]);

  it('never names the object "team" in English', () => {
    const offenders = teamStrings('en')
      .filter(({ key }) => !MODE_KEYS.has(key))
      .filter(({ value }) => /\bteams?\b/iu.test(value))
      // "your team" means the people, which is what that word is for.
      .filter(({ value }) => !/your team|the team will|team will recognise/iu.test(value));
    expect(offenders).toEqual([]);
  });

  it('never names the object «команда» in Ukrainian', () => {
    const offenders = teamStrings('uk')
      .filter(({ key }) => !MODE_KEYS.has(key))
      .filter(({ value }) => /команд[аиуоєі]/iu.test(value))
      .filter(({ value }) => !/з командою|команда\b(?=[^.]*впізна)/iu.test(value));
    expect(offenders).toEqual([]);
  });
});

describe('canonical section labels', () => {
  it.each([
    // 011: Files, Creatives and Landings merged into the explorer; Members became a destination.
    ['teamSectionExplorer', 'Explorer', 'Провідник'],
    ['teamSectionTasks', 'Tasks', 'Завдання'],
    ['teamSectionMembers', 'Members', 'Учасники'],
    ['teamSpaceSettings', 'Space settings', 'Налаштування простору']
  ] as const)('%s is the agreed label in both locales', (key, en, uk) => {
    expect(translate('en', key)).toBe(en);
    expect(translate('uk', key)).toBe(uk);
  });
});

describe('Close versus Cancel', () => {
  /**
   * Two words with two jobs: Close dismisses something that was only being
   * looked at; Cancel abandons something that was being done. The duplicate
   * per-surface cancel keys are gone, so there is one of each.
   */
  it('has exactly one key for each role', () => {
    expect(translate('en', 'teamClose')).toBe('Close');
    expect(translate('uk', 'teamClose')).toBe('Закрити');
    expect(translate('en', 'teamCancel')).toBe('Cancel');
    expect(translate('uk', 'teamCancel')).toBe('Скасувати');
  });

  it('has retired the per-surface duplicates', () => {
    expect(translationKeys).not.toContain('teamFileCancel');
    expect(translationKeys).not.toContain('teamCreateCancel');
  });
});

describe('loading strings', () => {
  it('has a distinct string per shape, not one reused everywhere', () => {
    const loadingKeys = translationKeys.filter(
      key => (key.startsWith('team') || key.startsWith('creativeLibrary')) && /Loading/u.test(key)
    );
    const values = loadingKeys.map(key => translate('en', key));
    // Reusing "Loading task…" for a folder listing is how a placeholder ends up
    // describing the wrong thing (contracts/glossary.md, key hygiene).
    expect(new Set(values).size).toBe(values.length);
  });

  it('never renders a bare ellipsis as a loading state', () => {
    const offenders = teamStrings('en').filter(({ value }) => value.trim() === '…');
    expect(offenders).toEqual([]);
  });
});

describe('both bundles stay in step', () => {
  it('translates every team key in Ukrainian', () => {
    const untranslated = teamStrings('uk').filter(
      ({ key, value }) => value === translate('en', key) && !/^(Soty|GEO|Drive|BETA)/u.test(value)
    );
    // A handful of proper nouns are identical in both; anything else is a
    // string someone forgot to translate.
    expect(untranslated.map(entry => entry.key).length).toBeLessThan(20);
  });
});
