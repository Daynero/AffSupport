import { readFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import { PRODUCTION_SITE_ORIGIN } from '../packages/shared/dist/release.js';

const environment = loadEnv('production', process.cwd(), '');
const memberPilot = process.argv.includes('--member-pilot');
const identityOnly = process.argv.includes('--identity');
const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SITE_URL'];
const failures = required
  .filter(name => !environment[name]?.trim())
  .map(name => `${name} is missing`);
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

if (releaseEnvironment.PUBLIC_SITE_ORIGIN !== PRODUCTION_SITE_ORIGIN)
  failures.push('the release production origin does not match shared PRODUCTION_SITE_ORIGIN');
if (siteOrigin && siteOrigin !== PRODUCTION_SITE_ORIGIN)
  failures.push('VITE_SITE_URL does not match shared PRODUCTION_SITE_ORIGIN');
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
