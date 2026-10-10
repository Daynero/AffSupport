import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeAnalyticsGuardContract,
  type AnalyticsGuardContractEntry
} from '../apps/web/src/analytics/guard-contract';

/**
 * 031 FR-048 — the client allowlist (`events.ts` ∪ the shared team sanitizer)
 * is the single source the database guard `analytics_properties_are_safe_v2`
 * is tested against. The guard's real body — from whichever migration defined
 * it last — runs in PGlite, and every key, vocabulary word, boolean and bound
 * the client knows is fed to it. Drift in either direction fails `npm run
 * verify`: a key the client sends and the guard refuses is a silently lost
 * event; a key the guard names and no sanitizer knows is dead allowlist.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const GUARD_DEFINITION =
  /create or replace function public\.analytics_properties_are_safe_v2\s*\(payload jsonb\)[\s\S]*?\$\$;/;

async function latestGuardMigration(): Promise<{ file: string; body: string; sql: string }> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(file => /^\d{14}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  for (const file of files.reverse()) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const match = GUARD_DEFINITION.exec(sql);
    if (match) return { file, body: match[0], sql };
  }
  throw new Error('No migration defines public.analytics_properties_are_safe_v2');
}

function quotedWords(fragment: string): string[] {
  return [...fragment.matchAll(/'([A-Za-z0-9_-]+)'/g)].map(match => match[1]);
}

/** The keys the guard's `property_key <> all (array[...])` allowlist names. */
function guardAllowlist(body: string): string[] {
  const match = /property_key <> all \(array\[([\s\S]*?)\]\)/.exec(body);
  if (!match) throw new Error('The guard has no key allowlist to compare against');
  return quotedWords(match[1]);
}

/** The keys the guard closes to a vocabulary with `case when payload ? 'key' then ... in (...)`. */
function guardEnumKeys(body: string): string[] {
  return [...body.matchAll(/case when payload \? '([a-z_]+)' then\s+payload ->> '\1' in \(/g)].map(
    match => match[1]
  );
}

const contract = describeAnalyticsGuardContract();
const enumEntries = contract.filter(
  (entry): entry is AnalyticsGuardContractEntry & { enum: readonly string[] } => entry.enum !== null
);
const booleanEntries = contract.filter(entry => entry.boolean);
const rangeEntries = contract.filter(
  (entry): entry is AnalyticsGuardContractEntry & { range: readonly [number, number] } =>
    entry.range !== null
);

describe('analytics guard contract (client allowlist vs. the real guard body in PGlite)', () => {
  let db: PGlite;
  let migration: { file: string; body: string; sql: string };

  beforeAll(async () => {
    migration = await latestGuardMigration();
    db = await PGlite.create();
    await db.exec(migration.body);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  async function safe(properties: Record<string, unknown>): Promise<boolean> {
    const result = await db.query<{ ok: boolean }>(
      'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
      [JSON.stringify(properties)]
    );
    return result.rows[0]?.ok === true;
  }

  it('describes a non-empty contract with the keys both sanitizers share', () => {
    expect(contract.length).toBeGreaterThan(80);
    const keys = contract.map(entry => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of ['tool_identifier', 'outcome', 'error_stage', 'attempt_id', 'had_agent']) {
      expect(keys).toContain(key);
    }
  });

  it('loads the newest migration that defines the guard', () => {
    expect(migration.file >= '20261117100000_analytics_guard_contract.sql').toBe(true);
  });

  it('accepts a representative value for every client key', async () => {
    const refused: string[] = [];
    for (const entry of contract) {
      if (!(await safe({ [entry.key]: entry.representative }))) refused.push(entry.key);
    }
    expect(refused, 'client keys the guard refuses').toEqual([]);
  });

  it('accepts every vocabulary word and refuses a word outside each vocabulary', async () => {
    const refusedWords: string[] = [];
    const openVocabularies: string[] = [];
    for (const entry of enumEntries) {
      for (const value of entry.enum) {
        if (!(await safe({ [entry.key]: value }))) refusedWords.push(`${entry.key}=${value}`);
      }
      if (await safe({ [entry.key]: '__bad__' })) openVocabularies.push(entry.key);
    }
    expect(refusedWords, 'vocabulary words the guard refuses').toEqual([]);
    expect(openVocabularies, 'client vocabularies the guard leaves open').toEqual([]);
  });

  it('accepts a boolean and refuses the string "true" for every boolean key', async () => {
    const refused: string[] = [];
    const open: string[] = [];
    for (const entry of booleanEntries) {
      if (!(await safe({ [entry.key]: true }))) refused.push(entry.key);
      if (await safe({ [entry.key]: 'true' })) open.push(entry.key);
    }
    expect(refused, 'boolean keys the guard refuses').toEqual([]);
    expect(open, 'boolean keys the guard lets a string through').toEqual([]);
  });

  it('accepts both bounds and refuses a value outside each numeric range', async () => {
    const refusedBounds: string[] = [];
    const openRanges: string[] = [];
    for (const entry of rangeEntries) {
      const [low, high] = entry.range;
      if (!(await safe({ [entry.key]: low }))) refusedBounds.push(`${entry.key}=${low}`);
      if (!(await safe({ [entry.key]: high }))) refusedBounds.push(`${entry.key}=${high}`);
      if (await safe({ [entry.key]: low - 1 })) openRanges.push(`${entry.key}<${low}`);
      if (await safe({ [entry.key]: high + 1 })) openRanges.push(`${entry.key}>${high}`);
      if (await safe({ [entry.key]: String(low) })) openRanges.push(`${entry.key} as string`);
    }
    expect(refusedBounds, 'range bounds the guard refuses').toEqual([]);
    expect(openRanges, 'client ranges the guard does not hold').toEqual([]);
  });

  it('names in SQL exactly the keys the client knows — drift reported both ways', () => {
    const sqlKeys = new Set(guardAllowlist(migration.body));
    const clientKeys = new Set(contract.map(entry => entry.key));
    const sqlOnly = [...sqlKeys].filter(key => !clientKeys.has(key)).sort();
    const clientOnly = [...clientKeys].filter(key => !sqlKeys.has(key)).sort();
    expect(sqlOnly, 'keys the guard allows and no client sanitizer knows').toEqual([]);
    expect(clientOnly, 'keys the client sends and the guard allowlist lacks').toEqual([]);
  });

  it('closes in SQL exactly the vocabularies the client closes', () => {
    const sqlEnumKeys = new Set(guardEnumKeys(migration.body));
    const clientEnumKeys = new Set(enumEntries.map(entry => entry.key));
    const sqlOnly = [...sqlEnumKeys].filter(key => !clientEnumKeys.has(key)).sort();
    const clientOnly = [...clientEnumKeys].filter(key => !sqlEnumKeys.has(key)).sort();
    expect(sqlOnly, 'vocabularies the guard closes and the client leaves open').toEqual([]);
    expect(clientOnly, 'vocabularies the client closes and the guard leaves open').toEqual([]);
  });

  it('refuses an unknown key, a path and a credential-shaped value as before', async () => {
    expect(await safe({ unknown_key: 1 })).toBe(false);
    expect(await safe({ error_code: '/Users/person' })).toBe(false);
    expect(await safe({ setting_name: 'token=abc' })).toBe(false);
    expect(await safe({})).toBe(true);
  });
});
