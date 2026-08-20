// One environment profile field, for shell and CI to read.
//
// The profiles in packages/shared/src/environment.ts are the single source of
// truth for what distinguishes production, dev, and beta — port, app name,
// bundle id, support directory, lock file. Packaging is where that mattered
// most and was honoured least: four entry points (package-mac.sh,
// package-dev-mac.sh, package-beta-mac.sh, .github/workflows/release-windows.yml)
// each spelled the values out again, and the production ones had already
// drifted from the profile that claimed to describe them.
//
// This is the seam that makes the profile real, mirroring scripts/release-meta.mjs.
//
//   node scripts/environment-meta.mjs <production|dev|beta> <field>
//   node scripts/environment-meta.mjs production agent-port      -> 43120
//
// Fields are kebab-case names of EnvironmentProfile keys. An unknown profile or
// field exits non-zero rather than printing an empty string: a packaging script
// that silently rendered an empty app name would produce a broken bundle.
import {
  BETA_PROFILE,
  DEV_PROFILE,
  PRODUCTION_PROFILE
} from '../packages/shared/dist/environment.js';

const profiles = {
  production: PRODUCTION_PROFILE,
  dev: DEV_PROFILE,
  beta: BETA_PROFILE
};

const fields = {
  'agent-port': 'agentPort',
  'web-port': 'webPort',
  'app-name': 'appName',
  'bundle-id': 'bundleId',
  'support-directory-name': 'supportDirectoryName',
  'instance-lock-name': 'instanceLockName',
  'release-channel': 'releaseChannel',
  environment: 'environment'
};

const [profileName, field] = process.argv.slice(2);
const profile = profiles[profileName];
if (!profile) {
  process.stderr.write(
    `Unknown environment profile ${JSON.stringify(profileName ?? '')}. ` +
      `Expected one of: ${Object.keys(profiles).join(', ')}.\n`
  );
  process.exit(1);
}

const key = fields[field];
if (!key) {
  process.stderr.write(
    `Unknown field ${JSON.stringify(field ?? '')}. ` +
      `Expected one of: ${Object.keys(fields).join(', ')}.\n`
  );
  process.exit(1);
}

const value = profile[key];
if (value === null || value === undefined) {
  process.stderr.write(`${profileName} has no ${field}.\n`);
  process.exit(1);
}
process.stdout.write(String(value));
