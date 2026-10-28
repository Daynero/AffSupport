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
   * The object is a Space, for one person as much as for fifty (024). "Team workspace" used to be
   * allowed as the name of the mode; it went, because a name that says "team" tells the media
   * buyer working alone that this is not for them. The owner-approved tariff showcase (9dca022d)
   * separately names a commercial plan "Team" and describes a group of people. Only its three
   * reviewed keys have that meaning; product objects and all other strings retain this rule.
   */
  const everyString = (locale: (typeof LOCALES)[number]) =>
    translationKeys.map(key => ({ key, value: translate(locale, key) }));
  const commercialContexts: ReadonlySet<string> = new Set([
    'tariffShowcaseLead',
    'tariffShowcaseTeam',
    'tariffShowcaseTeamDescription'
  ]);
  const objectNounOffenders = (entries: { key: string; value: string }[], pattern: RegExp) =>
    entries.filter(
      ({ key, value }) =>
        !commercialContexts.has(key) &&
        // Interpolation identifiers are replaced with values at render time;
        // their internal names are not interface vocabulary.
        pattern.test(value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/gu, ''))
    );

  it('keeps "team" out of object names outside reviewed commercial contexts', () => {
    const offenders = objectNounOffenders(everyString('en'), /\bteam(s|mates?)?\b/iu);
    expect(offenders).toEqual([]);
  });

  it('keeps «команда» out of object names outside reviewed commercial contexts', () => {
    const offenders = objectNounOffenders(everyString('uk'), /команд/iu);
    expect(offenders).toEqual([]);
  });
  it('does not exempt other showcase copy or product labels', () => {
    const entries = [
      { key: 'tariffShowcaseTeam', value: 'Team' },
      { key: 'tariffShowcaseOther', value: 'Team' },
      { key: 'teamSpaceSettings', value: 'Team settings' }
    ];
    expect(objectNounOffenders(entries, /\bteam\b/iu).map(entry => entry.key)).toEqual([
      'tariffShowcaseOther',
      'teamSpaceSettings'
    ]);
  });
  it('ignores interpolation identifiers while checking the surrounding visible copy', () => {
    const entries = [
      { key: 'storageUsage', value: 'This workspace: {team}. Other workspaces: {other}.' },
      { key: 'settingsLabel', value: 'Team settings: {workspace}' },
      { key: 'inviteLabel', value: 'Invite teammates to {workspace}' },
      { key: 'literalBraces', value: 'Choose {team settings}' }
    ];
    expect(objectNounOffenders(entries, /\bteam(s|mates?)?\b/iu).map(entry => entry.key)).toEqual([
      'settingsLabel',
      'inviteLabel',
      'literalBraces'
    ]);
  });
});

describe('canonical section labels', () => {
  it.each([
    // 011: Files, Creatives and Landings merged into the explorer; Members became a destination.
    ['teamSectionExplorer', 'Explorer', 'Провідник'],
    ['teamSectionTasks', 'Tasks', 'Завдання'],
    // 017: the accounts a space runs from, beside the tasks they will tag.
    ['teamSectionAccounts', 'Accounts', 'Акаунти'],
    ['teamSectionMembers', 'Members', 'Учасники'],
    ['teamSpaceSettings', 'Space settings', 'Налаштування простору'],
    ['catalogUpdaterEntry', 'Catalog Manager', 'Менеджер каталогів'],
    ['catalogUpdaterTitle', 'Catalog Manager', 'Менеджер каталогів']
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
