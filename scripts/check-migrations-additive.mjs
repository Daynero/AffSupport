#!/usr/bin/env node
/**
 * Feature 051: a migration may only add.
 *
 * A candidate's migrations reach production *before* anyone tests the
 * candidate, and stay there if it is cancelled or rolled back. The build that
 * is live while that happens -- and the one a rollback returns to -- runs on the
 * migrated database, so a migration that drops, renames, retypes or tightens
 * what it reads breaks production for a reason no rollback can undo.
 *
 * The analyser is the one the release backend plan already uses
 * (`clientBreakingStatements`), so CI and the release cannot disagree.
 * Migrations named at or before BASELINE predate this rule and are not judged.
 *
 * A deliberate cleanup -- removing what no live or rollback build still reads --
 * starts with the line `-- soty:cleanup`. It is reported but not blocked: such a
 * release goes through the workspace cutover gate of `release:backend-plan`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clientBreakingStatements } from './lib/release/migration-compat.mjs';

export const BASELINE = '20261207192000';
export const CLEANUP_MARKER = '-- soty:cleanup';

/**
 * @param {{name: string, sql: string}[]} migrations
 * @param {string} [baseline]
 */
export function judgeMigrations(migrations, baseline = BASELINE) {
  const blocked = [];
  const cleanups = [];
  for (const { name, sql } of migrations) {
    const version = name.split('_')[0];
    if (!/^\d{14}$/u.test(version) || version <= baseline) continue;
    const problems = clientBreakingStatements(sql);
    if (!problems.length) continue;
    if (sql.trimStart().startsWith(CLEANUP_MARKER)) cleanups.push({ name, problems });
    else blocked.push({ name, problems });
  }
  return { blocked, cleanups };
}

export function readMigrations(directory) {
  return readdirSync(directory)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .map(name => ({ name, sql: readFileSync(path.join(directory, name), 'utf8') }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { blocked, cleanups } = judgeMigrations(
    readMigrations(path.join(root, 'supabase/migrations'))
  );
  for (const { name, problems } of cleanups)
    process.stdout.write(
      `cleanup (allowed, needs workspace cutover at release): ${name}\n${problems.map(p => `  - ${p.reason}`).join('\n')}\n`
    );
  if (blocked.length) {
    process.stderr.write(
      'A migration may only add: production keeps running the previous build on this database, and a rollback cannot undo it.\n'
    );
    for (const { name, problems } of blocked)
      process.stderr.write(`${name}\n${problems.map(p => `  - ${p.reason}`).join('\n')}\n`);
    process.stderr.write(
      `Split the change: add now, remove in a later release whose first line is "${CLEANUP_MARKER}".\n`
    );
    process.exitCode = 1;
  } else process.stdout.write('Migrations: every migration after the baseline only adds.\n');
}
