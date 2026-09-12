#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeBinding } from './lib/release/bindings.mjs';
import {
  buildBackendPlan,
  describePlan,
  functionsNeedingDeploy
} from './lib/release/backend-scan.mjs';
import { createSupabaseBackendAdapter } from './lib/release/adapters/supabase-backend.mjs';

/**
 * Works out what this release has to do to the server, and writes it down.
 *
 * The backend plan was the last part of a release still assembled by a person
 * reading documents: which migrations, which functions, in what order. This
 * derives it from two facts nobody has to remember — what the remote migration
 * history is missing, and what git says changed since the previous release tag —
 * and prints it in the shape `resolveBackendPlan` accepts.
 *
 * It writes nothing anywhere. A plan that cannot be safely applied is refused
 * here, before any of the release's heavy work has started, with the statement
 * that makes it unsafe quoted back.
 *
 * Usage:
 *   node scripts/plan-backend-release.mjs [--since=<ref>] [--out=<file>]
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = (args.find(arg => arg.startsWith('--out=')) ?? '').slice('--out='.length);

function git(commandArgs) {
  return execFileSync('git', ['-C', root, ...commandArgs], {
    encoding: 'utf8',
    shell: false
  }).trim();
}

function accessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN?.trim()) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  try {
    return (
      /^SUPABASE_ACCESS_TOKEN=(.+)$/mu
        .exec(readFileSync(path.join(root, 'config/keys/supabase-release-cli.env'), 'utf8'))?.[1]
        ?.trim() ?? null
    );
  } catch {
    return null;
  }
}

const binding = activeBinding();
const token = accessToken();
if (!token) {
  process.stderr.write('Backend plan refused: no Supabase access token.\n');
  process.exit(1);
}

// The previous release tag, not the previous commit: a release ships everything
// since the last thing that shipped, and asking git removes the one input a
// person would otherwise have to remember correctly.
const since =
  (args.find(arg => arg.startsWith('--since=')) ?? '').slice('--since='.length) ||
  git(['describe', '--tags', '--abbrev=0', '--match', 'v*']);

const adapter = createSupabaseBackendAdapter({
  projectRef: binding.supabaseProject,
  targetId: binding.bindingId,
  root,
  accessToken: token
});

const pending = await adapter.pendingMigrations();
const changedPaths = git(['diff', '--name-only', `${since}..HEAD`])
  .split('\n')
  .filter(Boolean);
const allFunctions = readdirSync(path.join(root, 'supabase/functions'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name !== '_shared')
  .map(entry => entry.name);

const migrations = [];
for (const id of pending) {
  const file = readdirSync(path.join(root, 'supabase/migrations')).find(name =>
    name.startsWith(`${id}_`)
  );
  if (!file) {
    process.stderr.write(
      `Backend plan refused: the remote reports ${id} pending but no file matches it.\n`
    );
    process.exit(1);
  }
  migrations.push({
    id,
    digest: await adapter.digestOf({ kind: 'migration', id }),
    sql: readFileSync(path.join(root, 'supabase/migrations', file), 'utf8')
  });
}

const functions = [];
for (const name of functionsNeedingDeploy({ changedPaths, functions: allFunctions }))
  functions.push({ name, digest: await adapter.digestOf({ kind: 'function', id: name }) });

const { plan, blockers } = buildBackendPlan({ targetId: binding.bindingId, migrations, functions });

if (blockers.length) {
  process.stderr.write(`Backend plan refused:\n  ${blockers.join('\n  ')}\n`);
  process.exit(1);
}

const document = JSON.stringify(plan, null, 2);
if (out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.resolve(root, out), `${document}\n`, { mode: 0o600 });
  process.stdout.write(
    `Backend plan for ${binding.bindingId} since ${since}: ${describePlan(plan)}\n`
  );
  process.stdout.write(`Written to ${out}\n`);
} else {
  process.stdout.write(`${document}\n`);
}
