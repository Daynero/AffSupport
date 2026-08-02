import { execFileSync } from 'node:child_process';
import { loadEnv } from 'vite';
import {
  missingTeamProductionSecrets,
  parseSupabaseSecretNames
} from './lib/team-production-readiness.mjs';

function fail(message) {
  process.stderr.write(`Team production readiness check failed: ${message}\n`);
  process.exit(1);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const environment = loadEnv('production', process.cwd(), '');
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

const missing = missingTeamProductionSecrets(secretNames);
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

const payload = await response.json().catch(() => null);
if (!response.ok || !isRecord(payload) || payload.ok !== true || !isRecord(payload.value)) {
  fail(`the deployed provider-readiness endpoint returned HTTP ${response.status}`);
}
const readiness = payload.value;
if (
  readiness.ready !== true ||
  readiness.production !== true ||
  readiness.oauthMode !== 'verified' ||
  !isRecord(readiness.services) ||
  readiness.services.googleDrive !== true ||
  (readiness.services.invitationEmail !== true && readiness.services.directMemberAdd !== true) ||
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

const onboardingMode =
  readiness.services.invitationEmail === true ? 'email invitation' : 'direct-add testing';
console.log(`Team Workspace reports ready with ${onboardingMode} member onboarding.`);
