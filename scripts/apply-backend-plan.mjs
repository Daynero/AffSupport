#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeBinding } from './lib/release/bindings.mjs';
import { resolveBackendPlan } from './lib/release/backend-plan.mjs';
import { describePlan } from './lib/release/backend-scan.mjs';
import { applyBackendPlan } from './lib/release/adapters/backend.mjs';
import { createSupabaseBackendAdapter } from './lib/release/adapters/supabase-backend.mjs';
import { createJournal } from './lib/release/journal.mjs';

/**
 * Applies a backend plan on its own, without cutting a client release.
 *
 * Not a second procedure: it is the runner's `backend_apply` step, the same
 * adapter and the same gates, reachable for the case the runner cannot express
 * — a change that is only ever a server change. Deployed functions drifting
 * behind the repository is exactly that case, and the alternative was the thing
 * this whole effort exists to remove: `supabase functions deploy` typed ten
 * times from a document.
 *
 * Every safety property comes from `applyBackendPlan`: the remote pending set
 * must equal the plan exactly, each change's content must still hash to what was
 * reviewed, each must be one the released client survives, and the receipt is
 * written before the write so a crash leaves a state somebody can read.
 *
 * Usage:
 *   node scripts/apply-backend-plan.mjs --plan=<file>            # say what would happen
 *   node scripts/apply-backend-plan.mjs --plan=<file> --confirm  # do it
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const planPath = (args.find(arg => arg.startsWith('--plan=')) ?? '').slice('--plan='.length);
const confirm = args.includes('--confirm');

function fail(message) {
  process.stderr.write(`Backend apply refused: ${message}\n`);
  process.exit(1);
}

if (!planPath) fail('no --plan=<file>');

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
if (!token) fail('no Supabase access token');

const plan = resolveBackendPlan(
  JSON.parse(readFileSync(path.resolve(root, planPath), 'utf8')),
  binding.bindingId
);
const sourceSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
  encoding: 'utf8'
}).trim();

const adapter = createSupabaseBackendAdapter({
  projectRef: binding.supabaseProject,
  targetId: binding.bindingId,
  root,
  accessToken: /** @type {string} */ (token)
});

process.stdout.write(
  `${confirm ? 'Applying' : 'Would apply'} to ${binding.bindingId} (${binding.supabaseProject}) from ${sourceSha.slice(0, 12)}:\n` +
    `  ${describePlan(plan)}\n`
);

if (!confirm) {
  // The pending set is checked here too, so the rehearsal answers the question
  // that actually blocks an apply rather than only listing the plan back.
  const pending = await adapter.pendingMigrations();
  process.stdout.write(`  remote pending migrations: ${pending.join(', ') || 'none'}\n`);
  for (const change of plan.changes) {
    const digest = await adapter.digestOf(change);
    const compatible = await adapter.backwardsCompatible(change);
    if (digest !== change.digest)
      process.stdout.write(`  ! ${change.id} no longer matches the reviewed digest\n`);
    if (!compatible)
      process.stdout.write(`  ! ${change.id} is not compatible with the released client\n`);
  }
  process.stdout.write('\nNothing was changed. Add --confirm to perform it.\n');
  process.exit(0);
}

const runId = `backend-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
const journal = await createJournal(path.join(root, 'release/automation/backend', runId), runId);

try {
  const result = await applyBackendPlan({
    binding,
    plan,
    sourceSha,
    adapter,
    journal: {
      flush: async receipt => {
        await journal.append('backend-receipt', receipt);
      }
    }
  });
  for (const applied of result.applied) process.stdout.write(`  ${applied.id}: ${applied.state}\n`);
  process.stdout.write(
    `Applied ${result.writes} change(s). Journal: ${path.relative(root, journal.journalPath)}\n`
  );
} catch (error) {
  // Stop and say so. A half-applied nontransactional change is where invented
  // recoveries do their damage; the journal says what was about to happen.
  fail(
    `${error instanceof Error ? error.message : 'unknown error'} (journal: ${path.relative(root, journal.journalPath)})`
  );
}
