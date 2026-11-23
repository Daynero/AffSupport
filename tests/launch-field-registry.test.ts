import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assistantFieldPaths,
  checkLaunchFieldValue,
  LAUNCH_DEFAULT_FIELDS,
  LAUNCH_FIELDS,
  launchField,
  launchFieldGuide
} from '@video-compressor/shared';

/**
 * 064 FR-008 / SC-007: the registry names every setting the Launch form edits. The editor's own
 * change calls are read from source, so a new control without a registry entry turns this red.
 */
const EDITOR_FILES = [
  'apps/web/src/team/launches/LaunchEditor.tsx',
  'apps/web/src/team/launches/LaunchCatalogVideoFields.tsx',
  'apps/web/src/team/launches/LaunchRestitchDurationField.tsx',
  'apps/web/src/team/launches/LaunchCreativePicker.tsx',
  'apps/web/src/team/launches/LaunchCreativeList.tsx',
  'apps/web/src/team/launches/LaunchDateField.tsx',
  'apps/web/src/team/launches/LaunchNotes.tsx'
];

/** Keys the form writes that are derived, not chosen by a person. */
const DERIVED = new Set([
  'materialId',
  'creativeAlias',
  'creativeKind',
  'timezone',
  'schemaVersion',
  'catalogVideoProtocolVersion'
]);

function editedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of EDITOR_FILES) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/changed\(\{\s*([a-zA-Z]+)\s*[:,}]/gu)) keys.add(match[1]!);
    for (const match of source.matchAll(/changed\(\{\s*[a-zA-Z]+:[^}]*?,\s*([a-zA-Z]+)\s*[:,}]/gu))
      keys.add(match[1]!);
    // The generic number and dictionary fields take their key as a literal argument.
    for (const match of source.matchAll(/\b(?:number|dictionary)\(\s*'([a-zA-Z]+)'/gu))
      keys.add(match[1]!);
    for (const match of source.matchAll(/catalog!?\s*,\s*([a-zA-Z]+)\s*[:}]/gu))
      keys.add(`catalog.${match[1]}`);
    for (const match of source.matchAll(/\.\.\.(?:value|catalog)\s*,\s*([a-zA-Z]+)\s*:/gu))
      keys.add(`catalog.${match[1]}`);
  }
  return keys;
}

describe('064 launch field registry', () => {
  it('describes every field the Launch form edits', () => {
    const known = new Set(LAUNCH_FIELDS.map(field => field.path));
    const topLevel = new Set(LAUNCH_FIELDS.map(field => field.path.split('.')[0]!));
    const missing = [...editedKeys()].filter(key => {
      if (DERIVED.has(key) || DERIVED.has(key.replace(/^catalog\./u, ''))) return false;
      if (key === 'catalog' || key === 'subConfig') return false;
      // A key inside `catalog: { ...config.catalog!, key }` is a catalog field.
      return !known.has(key) && !topLevel.has(key) && !known.has(`catalog.${key}`);
    });
    expect(missing).toEqual([]);
  });

  it('covers the profile boundary the form saves as offer defaults', () => {
    const paths = new Set(LAUNCH_FIELDS.map(field => field.path.split('.')[0]!));
    for (const key of LAUNCH_DEFAULT_FIELDS) {
      if (key === 'timezone') continue; // derived from the person's zone
      expect(paths.has(key), key).toBe(true);
    }
  });

  it('opens tier 1 to the assistant and keeps tier 2 form-only until its parity test exists', () => {
    const paths = assistantFieldPaths();
    expect(paths).toContain('catalog.copyVideoToR2');
    expect(paths).toContain('creatives');
    expect(paths).not.toContain('notes');
    for (const field of LAUNCH_FIELDS) {
      if (field.tier === 1) expect(field.assistant, field.path).toBe(true);
    }
    expect(launchFieldGuide()).not.toContain('notes (');
  });

  it('checks a proposed value against the field it targets', () => {
    expect(checkLaunchFieldValue('campaignCount', 'set', 5)).toEqual({ ok: true, value: 5 });
    expect(checkLaunchFieldValue('campaignCount', 'set', 0)).toEqual({
      ok: false,
      code: 'INVALID_VALUE'
    });
    expect(checkLaunchFieldValue('campaignCount', 'set', '5')).toEqual({
      ok: false,
      code: 'INVALID_VALUE'
    });
    expect(checkLaunchFieldValue('catalog.productCount', 'set', 401)).toEqual({
      ok: false,
      code: 'INVALID_VALUE'
    });
    expect(checkLaunchFieldValue('maxBudget', 'set', 20.5)).toEqual({ ok: true, value: 20.5 });
    expect(checkLaunchFieldValue('maxBudget', 'set', 20.555)).toEqual({
      ok: false,
      code: 'INVALID_VALUE'
    });
    expect(checkLaunchFieldValue('budgetMode', 'set', 'single')).toEqual({
      ok: true,
      value: 'single'
    });
    expect(checkLaunchFieldValue('budgetMode', 'set', 'smart')).toEqual({
      ok: false,
      code: 'INVALID_VALUE'
    });
    expect(checkLaunchFieldValue('catalog.copyVideoToR2', 'set', false)).toEqual({
      ok: true,
      value: false
    });
    expect(checkLaunchFieldValue('originalUrl', 'clear', null)).toEqual({
      ok: true,
      value: undefined
    });
    expect(checkLaunchFieldValue('campaignCount', 'clear', null)).toEqual({
      ok: false,
      code: 'OP_NOT_ALLOWED'
    });
    expect(checkLaunchFieldValue('notes', 'set', [])).toEqual({
      ok: false,
      code: 'FIELD_FORM_ONLY'
    });
    expect(checkLaunchFieldValue('materialId', 'set', 'x')).toEqual({
      ok: false,
      code: 'FIELD_NOT_SUPPORTED'
    });
    expect(checkLaunchFieldValue('subConfig.sub2', 'set', ['social', 'creative'])).toEqual({
      ok: true,
      value: ['social', 'creative']
    });
    expect(checkLaunchFieldValue('subConfig.sub2', 'set', ['email'])).toEqual({
      ok: false,
      code: 'INVALID_VALUE'
    });
    expect(checkLaunchFieldValue('creatives', 'set', ['TR_16', ' TR_18 '])).toEqual({
      ok: true,
      value: ['TR_16', 'TR_18']
    });
  });

  it('keeps one entry per path', () => {
    const paths = LAUNCH_FIELDS.map(field => field.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(launchField('nope')).toBeNull();
  });
});
