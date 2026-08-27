import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadEnv } from 'vite';
import {
  missingTeamProductionSecrets,
  parseSupabaseSecretNames
} from './lib/team-production-readiness.mjs';

/**
 * Reports and exits.
 *
 * Annotated `never` so the checker knows control does not continue past a call
 * — without it, every value guarded by a `fail()` reads as possibly undefined
 * further down, which is the shape most of this file's type errors took.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`Team production readiness check failed: ${message}\n`);
  process.exit(1);
}

/**
 * A type guard, not just a boolean: without the annotation the checker learns
 * nothing from the call and every field read afterwards is an error on
 * `unknown`.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const environment = loadEnv('production', path.join(process.cwd(), 'apps/web'), '');
const memberPilot = process.argv.includes('--member-pilot');
const supabaseUrl = environment.VITE_SUPABASE_URL?.trim();
const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const siteUrl = environment.VITE_SITE_URL?.trim();
if (!supabaseUrl || !publishableKey || !siteUrl) {
  fail('VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, and VITE_SITE_URL are required');
}

let projectRef;
try {
  const parsed = new URL(supabaseUrl);
  projectRef = parsed.hostname.endsWith('.supabase.co') ? parsed.hostname.split('.')[0] : null;
} catch {
  projectRef = null;
}
if (!projectRef || !/^[a-z0-9]+$/i.test(projectRef)) fail('VITE_SUPABASE_URL is not a project URL');

let secretNames;
try {
  const output = execFileSync(
    'npx',
    ['supabase@2.111.0', 'secrets', 'list', '--project-ref', projectRef, '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const response = JSON.parse(output);
  secretNames = parseSupabaseSecretNames(response);
} catch (error) {
  fail(error instanceof Error ? error.message : 'could not inspect Supabase secrets');
}

const missing = missingTeamProductionSecrets(secretNames, { memberPilot });
if (missing.length > 0) fail(`missing Supabase secrets: ${missing.join(', ')}`);

let response;
try {
  response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/drive-connect/readiness`, {
    headers: { apikey: publishableKey, origin: siteUrl },
    signal: AbortSignal.timeout(10_000)
  });
} catch {
  fail('the deployed provider-readiness endpoint is unavailable');
}

const payload = /** @type {unknown} */ (await response.json().catch(() => null));
if (!response.ok || !isRecord(payload) || payload.ok !== true || !isRecord(payload.value)) {
  fail(`the deployed provider-readiness endpoint returned HTTP ${response.status}`);
}
const readiness = payload.value;
if (memberPilot) {
  if (
    readiness.production !== true ||
    readiness.memberOnboarding !== 'direct_add_testing' ||
    !isRecord(readiness.services) ||
    readiness.services.directMemberAdd !== true
  ) {
    fail('deployed direct-add member pilot is not explicitly ready');
  }
  console.log('Team member pilot reports direct-add testing ready.');
  process.exit(0);
}

if (
  readiness.ready !== true ||
  readiness.fullProviderReady !== true ||
  readiness.production !== true ||
  readiness.oauthMode !== 'verified' ||
  !isRecord(readiness.services) ||
  readiness.services.googleDrive !== true ||
  readiness.services.invitationEmail !== true ||
  readiness.services.catalogWorker !== true
) {
  const unavailable = isRecord(readiness.services)
    ? Object.entries(readiness.services)
        .filter(([, available]) => available !== true)
        .map(([service]) => service)
    : ['unknown'];
  fail(
    `deployed providers are not ready (mode=${String(readiness.oauthMode)}, unavailable=${unavailable.join(',')})`
  );
}

console.log('Team Workspace production providers are configured and report fully ready.');
