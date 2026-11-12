import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * The contract seed (20260801090000) is regenerated from the contract, so a code added to the
 * contract lands in a migration production applied on 2026-08-01 and never runs again there.
 * Thirty-five codes reached production only through 20261207400100, after a foreign key refused
 * 'ALREADY_COMPLETED' and a launch failed before it started (2026-11-12). Every code in the seed
 * must also be inserted by some later migration.
 */
const DIR = 'supabase/migrations';
const SEED = '20260801090000_team_contract_seed.sql';
const codes = (sql: string) =>
  new Set(
    [
      ...sql.matchAll(/insert into public\.team_error_codes\s*\(code\)\s*values([^;]*);/giu)
    ].flatMap(match => [...match[1]!.matchAll(/'([A-Z][A-Z0-9_]+)'/gu)].map(code => code[1]!))
  );

it('every error code of the contract seed is also inserted by a migration that runs after it', () => {
  const seeded = codes(readFileSync(`${DIR}/${SEED}`, 'utf8'));
  const later = new Set<string>();
  for (const file of readdirSync(DIR).filter(name => name.endsWith('.sql') && name > SEED))
    for (const code of codes(readFileSync(`${DIR}/${file}`, 'utf8'))) later.add(code);
  expect([...seeded].filter(code => !later.has(code))).toEqual([]);
});
