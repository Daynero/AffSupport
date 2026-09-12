import { readFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import { activeBinding } from './lib/release/bindings.mjs';
import { loadRegistry, validateValues } from './lib/env-registry.mjs';

// The destination this verification is about. Production by default and pinned
// there; a sandbox release supplies its own validated, disjoint binding.
const binding = activeBinding();

// The build reads its env from the repository root (apps/web/vite.config.ts sets
// envDir: '../..'), so the gate must read the same directory. Reading apps/web
// let a value pass here that the bundle never received.
const environment = loadEnv('production', process.cwd(), '');
const memberPilot = process.argv.includes('--member-pilot');
const identityOnly = process.argv.includes('--identity');
/**
 * What production must have comes from config/environments.json, not from a
 * list retyped here. A list in this file is a list that stops growing the day
 * somebody adds a variable and forgets this gate exists — which is precisely
 * how a build passed while production was missing a value it needed.
 *
 * The chooser keys are the one conditional: an identity-only deployment does
 * not open a Drive chooser, so their absence is correct there and only there.
 */
const DRIVE_DEPENDENT = ['VITE_GOOGLE_PICKER_API_KEY', 'VITE_GOOGLE_PROJECT_NUMBER'];
const registry = loadRegistry(process.cwd());
const failures = validateValues(registry, 'web', 'production', environment)
  .filter(problem => !(identityOnly && DRIVE_DEPENDENT.includes(problem.name)))
  .map(problem => `${problem.name} ${problem.problem}`);
const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

function legacyRole(key) {
  const payload = key.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(
      Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64url').toString('utf8')
    ).role;
  } catch {
    return null;
  }
}

if (
  /^sb_(?:secret|service_role)_/i.test(publishableKey) ||
  legacyRole(publishableKey) === 'service_role'
)
  failures.push('the Supabase browser key is privileged');

let siteOrigin = null;
try {
  const site = new URL(environment.VITE_SITE_URL);
  if (site.protocol !== 'https:' || site.pathname !== '/' || site.search || site.hash)
    failures.push('VITE_SITE_URL is not a production HTTPS origin');
  else siteOrigin = site.origin;
} catch {
  if (environment.VITE_SITE_URL) failures.push('VITE_SITE_URL is invalid');
}

const releaseEnvironment = Object.fromEntries(
  (await readFile('config/production.env', 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    })
);

if (releaseEnvironment.PUBLIC_SITE_ORIGIN !== binding.siteOrigin)
  failures.push(`the release origin does not match the ${binding.bindingId} binding origin`);
if (siteOrigin && siteOrigin !== binding.siteOrigin)
  failures.push(`VITE_SITE_URL does not match the ${binding.bindingId} binding origin`);
if (!memberPilot && !identityOnly && releaseEnvironment.DRIVE_OAUTH_MODE !== 'verified')
  failures.push('production team OAuth requires DRIVE_OAUTH_MODE=verified');
if (identityOnly && releaseEnvironment.DRIVE_OAUTH_MODE !== 'disabled')
  failures.push('identity-only deployment requires DRIVE_OAUTH_MODE=disabled');
if (memberPilot && environment.VITE_TEAM_DIRECT_ADD_MODE?.trim() !== 'testing')
  failures.push('member pilot requires VITE_TEAM_DIRECT_ADD_MODE=testing');
if (
  environment.VITE_TEAM_DIRECT_ADD_MODE &&
  !['disabled', 'testing'].includes(environment.VITE_TEAM_DIRECT_ADD_MODE.trim())
)
  failures.push('VITE_TEAM_DIRECT_ADD_MODE must be disabled or testing');

if (failures.length) {
  console.error(`Production web environment check failed: ${failures.join('; ')}.`);
  process.exitCode = 1;
} else {
  console.log(
    memberPilot
      ? 'Member-pilot web environment is complete and explicitly labels direct-add testing.'
      : identityOnly
        ? 'Identity-only web environment is complete and leaves Drive OAuth disabled.'
        : 'Production web environment is complete, uses only a public Supabase key, and pins verified team OAuth.'
  );
}
