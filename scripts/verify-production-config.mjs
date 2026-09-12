#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeBinding } from './lib/release/bindings.mjs';
import { loadRegistry, requiredNames, variablesFor } from './lib/env-registry.mjs';
import {
  authProblems,
  functionParity,
  migrationDrift,
  missingSecrets,
  undeclaredSecrets
} from './lib/production-config.mjs';

/**
 * Asks the live project whether it can actually run the code we are about to
 * ship it.
 *
 * Every other gate in this repository checks the code, the artifacts, or the
 * local environment — things this machine can see. None of them can see the one
 * state that has actually taken production down: a secret nobody set, a
 * function nobody deployed, a migration nobody applied, a redirect nobody added.
 * Beta cannot see it either, by construction: beta is a loopback stack with its
 * own keys, so it proves the code correct and says nothing about whether
 * production is configured to run it.
 *
 * It reads and never writes. Secret *names* are compared; no value is read,
 * printed, or sent anywhere.
 *
 * Usage:
 *   node scripts/verify-production-config.mjs [--expect-pending=<id>,<id>] [--json]
 *
 * `--expect-pending` is how a release that declares migrations says so. Without
 * it, a migration that exists here and not there is drift and blocks.
 */

export const SUPABASE_CLI = 'supabase@2.117.0';
const MANAGEMENT_API = 'https://api.supabase.com';
const CALL_TIMEOUT_MS = 180_000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const expectPending = (args.find(arg => arg.startsWith('--expect-pending=')) ?? '')
  .slice('--expect-pending='.length)
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean);

const failures = [];
const notes = [];

/**
 * The token lives in an untracked key file so that neither a shell profile nor
 * a committed script has to carry it. Absent, this gate fails rather than
 * passing quietly — an unverifiable project is not a verified one.
 */
function accessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN?.trim()) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  try {
    const file = readFileSync(path.join(root, 'config/keys/supabase-release-cli.env'), 'utf8');
    const match = /^SUPABASE_ACCESS_TOKEN=(.+)$/mu.exec(file);
    if (match) return match[1].trim();
  } catch {
    /* reported by the caller as an absent token */
  }
  return null;
}

const resolvedToken = accessToken();
if (!resolvedToken) {
  process.stderr.write(
    'Production configuration check failed: no Supabase access token.\n' +
      '  Set SUPABASE_ACCESS_TOKEN or restore config/keys/supabase-release-cli.env.\n'
  );
  process.exit(1);
}
/** Narrowed once, so neither the CLI nor the API call has to re-prove it. */
const token = /** @type {string} */ (resolvedToken);

const binding = activeBinding();
const projectRef = binding.supabaseProject;
const registry = loadRegistry(root);

function cli(commandArgs) {
  return execFileSync('npx', ['--yes', SUPABASE_CLI, ...commandArgs], {
    encoding: 'utf8',
    timeout: CALL_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: token }
  });
}

/**
 * `migration list` prints progress lines before its JSON, and a skipped-file
 * notice in the middle of them. Taking the last line that parses is the only
 * reading that survives the CLI adding another message.
 */
function lastJsonLine(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      /* not this line */
    }
  }
  throw new Error('no JSON in CLI output');
}

async function management(endpoint) {
  const response = await fetch(`${MANAGEMENT_API}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// --- secrets ---------------------------------------------------------------
let secretNames = null;
try {
  secretNames = JSON.parse(cli(['secrets', 'list', '--project-ref', projectRef, '-o', 'json']))
    .filter(entry => typeof entry?.name === 'string')
    .map(entry => entry.name);
} catch (error) {
  failures.push(
    `could not list Supabase secrets: ${error instanceof Error ? error.message : 'unknown error'}`
  );
}

if (secretNames) {
  const required = requiredNames(registry, 'functions', 'production');
  for (const name of missingSecrets(required, secretNames)) {
    const variable = variablesFor(registry, 'functions').find(entry => entry.name === name);
    failures.push(
      `secret ${name} is not set on ${projectRef} — ${variable?.note ?? 'required in production'}`
    );
  }
  const declared = variablesFor(registry, 'functions').map(entry => entry.name);
  const extra = undeclaredSecrets(declared, secretNames);
  if (extra.length) notes.push(`secrets set but not declared in the registry: ${extra.join(', ')}`);
}

// --- functions -------------------------------------------------------------
let deployed = null;
try {
  deployed = JSON.parse(cli(['functions', 'list', '--project-ref', projectRef, '-o', 'json']));
} catch (error) {
  failures.push(
    `could not list Edge Functions: ${error instanceof Error ? error.message : 'unknown error'}`
  );
}

if (deployed) {
  const localFunctions = readdirSync(path.join(root, 'supabase/functions'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== '_shared')
    .map(entry => entry.name);
  const parity = functionParity(localFunctions, deployed);
  for (const slug of parity.missing)
    failures.push(
      `function ${slug} exists here but is not deployed to ${projectRef} — it answers 404`
    );
  for (const slug of parity.inactive)
    failures.push(`function ${slug} is deployed but not ACTIVE on ${projectRef}`);
  if (parity.undeclared.length)
    notes.push(
      `functions deployed but absent from this repository: ${parity.undeclared.join(', ')}`
    );
}

// --- migrations ------------------------------------------------------------
try {
  const listed = lastJsonLine(cli(['migration', 'list', '--linked']));
  const drift = migrationDrift(listed.migrations ?? [], expectPending);
  for (const version of drift.unapplied)
    failures.push(
      `migration ${version} exists here but is not applied to ${projectRef} — ` +
        `declare it in the release plan or apply it before shipping code that assumes it`
    );
  for (const version of drift.untracked)
    failures.push(
      `migration ${version} is applied on ${projectRef} but absent from this repository`
    );
  if (drift.planned.length)
    notes.push(`migrations this release declares: ${drift.planned.join(', ')}`);
} catch (error) {
  failures.push(
    `could not compare migrations: ${error instanceof Error ? error.message : 'unknown error'}`
  );
}

// --- auth round trip -------------------------------------------------------
try {
  const config = await management(`/v1/projects/${projectRef}/config/auth`);
  for (const problem of authProblems(
    { siteUrl: config.site_url, allowList: config.uri_allow_list },
    binding.siteOrigin
  ))
    failures.push(problem);
  if (config.external_google_enabled !== true)
    failures.push('the Google identity provider is disabled on the project');
} catch (error) {
  failures.push(
    `could not read the project auth configuration: ${error instanceof Error ? error.message : 'unknown error'}`
  );
}

// --- report ----------------------------------------------------------------
const result = {
  ok: failures.length === 0,
  binding: binding.bindingId,
  project: projectRef,
  origin: binding.siteOrigin,
  failures,
  notes
};

if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else if (failures.length)
  process.stderr.write(
    `Production configuration check failed (${projectRef}):\n  ${failures.join('\n  ')}\n` +
      (notes.length ? `Notes:\n  ${notes.join('\n  ')}\n` : '')
  );
else
  process.stdout.write(
    `Production configuration matches the registry (${projectRef}, ${binding.siteOrigin}).\n` +
      (notes.length ? `${notes.map(note => `  note: ${note}`).join('\n')}\n` : '')
  );

process.exit(failures.length ? 1 : 0);
