/**
 * Environment identity.
 *
 * A running copy of Soty belongs to exactly one environment, and many
 * behaviours key on which: the beta indicator, analytics suppression, whether
 * loopback origins are legal, whether the production update manifest is
 * queried, and every isolation guard. Deriving those from a scatter of
 * independent booleans would let them drift apart, which is precisely how a
 * half-beta build gets created — so they all read one value from here.
 *
 * Absent or empty means `production`. The failure direction is deliberate: a
 * mistake must yield the stricter environment, never silently produce a beta
 * build. The beta tooling asserts the value explicitly rather than relying on
 * this default.
 */
import { isLoopbackOrigin, isProductionEndpoint } from './environment-runtime.js';
import type { AppEnvironment } from './environment-runtime.js';

export {
  APP_ENVIRONMENTS,
  appEnvironmentOrProduction,
  isLoopbackOrigin,
  isProductionEndpoint,
  parseAppEnvironment
} from './environment-runtime.js';
export type { AppEnvironment, ParsedAppEnvironment } from './environment-runtime.js';

/**
 * Everything that distinguishes one running copy from another. Declared once
 * so no script, launcher, or test re-derives a port or a directory name; the
 * distinctness of these slots is what lets production, dev, and beta run side
 * by side on one machine.
 *
 * "Declared once" is load-bearing rather than aspirational: every packaging
 * entry point reads these through `scripts/environment-meta.mjs`, and
 * `tests/environment-packaging.test.ts` fails if one starts spelling a value
 * out again. A profile that nothing consumed would drift from the artifacts it
 * claims to describe, and the drift would surface as two copies of Soty
 * fighting over one lock file.
 */
export interface EnvironmentProfile {
  /** Which environment identity this profile carries. `dev` is a production-identity build. */
  environment: AppEnvironment;
  agentPort: number;
  /** Local web dev-server port; null for the hosted production site. */
  webPort: number | null;
  appName: string;
  bundleId: string;
  supportDirectoryName: string;
  instanceLockName: string;
  releaseChannel: string;
}

export const PRODUCTION_PROFILE: EnvironmentProfile = {
  environment: 'production',
  agentPort: 43120,
  webPort: null,
  appName: 'Soty',
  // These are the identities the shipped app already carries, not tidier ones
  // this file would prefer. They predate the rebrand and cannot be changed
  // without orphaning every installed copy: the bundle id is what macOS keys
  // permissions and login items on, and the lock name is how a running agent
  // recognises itself during an update handoff. `scripts/environment-meta.mjs`
  // feeds them straight into packaging, so a "cleanup" here would silently
  // become a breaking change there.
  bundleId: 'local.video.compressor.test',
  supportDirectoryName: 'Soty',
  instanceLockName: 'local-video-compressor-agent.lock',
  releaseChannel: 'stable'
};

/**
 * The existing `Soty Dev` package (scripts/package-dev-mac.sh). It carries the
 * production environment identity — it is a tool for working on the app, not a
 * mirror for verifying it — but occupies its own port and directory slots.
 */
export const DEV_PROFILE: EnvironmentProfile = {
  environment: 'production',
  agentPort: 43130,
  webPort: 5173,
  appName: 'Soty Dev',
  bundleId: 'com.wishly.dev',
  supportDirectoryName: 'Soty Dev',
  instanceLockName: 'wishly-dev-agent.lock',
  releaseChannel: 'development'
};

export const BETA_PROFILE: EnvironmentProfile = {
  environment: 'beta',
  agentPort: 43140,
  webPort: 5175,
  appName: 'Soty Beta',
  bundleId: 'com.wishly.beta',
  supportDirectoryName: 'Soty Beta',
  instanceLockName: 'wishly-beta-agent.lock',
  releaseChannel: 'beta'
};

export const ENVIRONMENT_PROFILES: readonly EnvironmentProfile[] = [
  PRODUCTION_PROFILE,
  DEV_PROFILE,
  BETA_PROFILE
];

/** Ports the local Supabase stack occupies; the beta doctor checks these too. */
export const BETA_LOCAL_STACK_PORTS: readonly number[] = [54321, 54322, 54323, 54324];

export const BETA_SITE_ORIGIN = `http://127.0.0.1:${BETA_PROFILE.webPort}`;
export const BETA_AGENT_ORIGIN = `http://127.0.0.1:${BETA_PROFILE.agentPort}`;

/**
 * Markers that identify a beta artifact or a beta setting. The production
 * release gate scans for these, so they live beside the profile that produces
 * them rather than being retyped in a script.
 */
export const BETA_MARKERS: readonly string[] = [
  'VITE_APP_ENVIRONMENT=beta',
  'SOTY_ENVIRONMENT=beta',
  BETA_PROFILE.bundleId,
  BETA_PROFILE.appName,
  BETA_PROFILE.instanceLockName,
  String(BETA_PROFILE.agentPort),
  BETA_SITE_ORIGIN,
  BETA_AGENT_ORIGIN
];

/* -------------------------------------------------------------------------
 * Beta isolation guard
 *
 * The rules live here, pure and typed, so the same logic serves the doctor
 * script, the agent's startup assertion, and the tests. Anything requiring I/O
 * (port probing, container-runtime detection, git) is passed in as a probe
 * result rather than performed here, which is what makes the guard
 * deterministically testable.
 * ---------------------------------------------------------------------- */

export type BetaGuardCode =
  | 'BETA_ENV_MISSING'
  | 'BETA_PRODUCTION_ENDPOINT'
  | 'BETA_LOCAL_AUTH_FORBIDDEN'
  | 'BETA_DELIVERY_PROVIDER_FORBIDDEN'
  | 'BETA_PORT_IN_USE'
  | 'BETA_PREREQUISITE_MISSING'
  | 'BETA_RESET_TARGET_UNSAFE';

export interface BetaGuardProblem {
  code: BetaGuardCode;
  /** Names the offending setting or resource — never a bare category. */
  subject: string;
  message: string;
  remedy: string;
}

export interface BetaEnvironmentProbes {
  /** Ports found occupied by something else. */
  portsInUse?: readonly number[];
  /** Prerequisites that were looked for and not found. */
  missingPrerequisites?: readonly string[];
  /** Production entitlement key, so beta can refuse to reuse it. */
  productionEntitlementKey?: string | null;
}

/** Keys a beta profile must define before anything is started. */
export const BETA_REQUIRED_KEYS: readonly string[] = [
  'VITE_APP_ENVIRONMENT',
  'SOTY_ENVIRONMENT',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SITE_URL',
  'VITE_AGENT_URL',
  'AGENT_PORT',
  'PUBLIC_SITE_ORIGIN',
  'DEV_SITE_ORIGIN',
  'AGENT_SUPPORT_DIRECTORY_NAME',
  'AGENT_ENTITLEMENT_PUBLIC_KEY'
];

/** Keys holding an origin that must point at this machine and nowhere else. */
const BETA_ORIGIN_KEYS: readonly string[] = [
  'VITE_SUPABASE_URL',
  'VITE_SITE_URL',
  'VITE_AGENT_URL',
  'PUBLIC_SITE_ORIGIN',
  'DEV_SITE_ORIGIN'
];

/**
 * Third-party message-delivery credentials. Team invitations do not travel
 * through the local mail catcher — the edge function posts straight to a
 * delivery API — so a credential here would send real invitations to real
 * people from a test environment.
 */
const BETA_FORBIDDEN_DELIVERY_KEYS: readonly string[] = ['RESEND_API_KEY', 'INVITE_EMAIL_FROM'];

type EnvRecord = Readonly<Record<string, string | undefined>>;

function read(env: EnvRecord, key: string): string {
  const raw = env[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Evaluates a beta profile and returns every problem found, not just the
 * first: a maintainer with three things wrong should fix them in one pass
 * rather than three cycles.
 */
export function evaluateBetaEnvironment(
  env: EnvRecord,
  probes: BetaEnvironmentProbes = {}
): BetaGuardProblem[] {
  const problems: BetaGuardProblem[] = [];

  for (const key of BETA_REQUIRED_KEYS) {
    if (!read(env, key)) {
      problems.push({
        code: 'BETA_ENV_MISSING',
        subject: key,
        message: `${key} is not set in the beta profile.`,
        remedy: `Set ${key} in .env.beta — see .env.beta.example.`
      });
    }
  }

  const environment = read(env, 'VITE_APP_ENVIRONMENT');
  const agentEnvironment = read(env, 'SOTY_ENVIRONMENT');
  for (const [key, value] of [
    ['VITE_APP_ENVIRONMENT', environment],
    ['SOTY_ENVIRONMENT', agentEnvironment]
  ] as const) {
    if (value && value !== 'beta') {
      problems.push({
        code: 'BETA_ENV_MISSING',
        subject: key,
        message: `${key} is ${JSON.stringify(value)}, but the beta profile requires "beta".`,
        remedy: `Set ${key}=beta in .env.beta.`
      });
    }
  }

  for (const key of BETA_ORIGIN_KEYS) {
    const value = read(env, key);
    if (value && isProductionEndpoint(value)) {
      problems.push({
        code: 'BETA_PRODUCTION_ENDPOINT',
        subject: key,
        message: `${key} points at ${value}, which is not on this machine.`,
        remedy: `Point ${key} at a 127.0.0.1 address — beta must never reach production.`
      });
    }
  }

  const entitlementKey = read(env, 'AGENT_ENTITLEMENT_PUBLIC_KEY');
  const productionKey = (probes.productionEntitlementKey ?? '').trim();
  if (entitlementKey && productionKey && entitlementKey === productionKey) {
    problems.push({
      code: 'BETA_PRODUCTION_ENDPOINT',
      subject: 'AGENT_ENTITLEMENT_PUBLIC_KEY',
      message: 'The beta entitlement key is the production key.',
      remedy:
        'Run `node scripts/generate-signing-keys.mjs --beta` and use the beta public key, so a production token is invalid in beta and vice versa.'
    });
  }

  if (read(env, 'VITE_LOCAL_DEV_AUTH') === 'true') {
    problems.push({
      code: 'BETA_LOCAL_AUTH_FORBIDDEN',
      subject: 'VITE_LOCAL_DEV_AUTH',
      message: 'VITE_LOCAL_DEV_AUTH=true substitutes a hardcoded user and bypasses sign-in.',
      remedy:
        'Set VITE_LOCAL_DEV_AUTH=false — beta exists to exercise real authentication, sessions, and account status.'
    });
  }

  for (const key of BETA_FORBIDDEN_DELIVERY_KEYS) {
    if (read(env, key)) {
      problems.push({
        code: 'BETA_DELIVERY_PROVIDER_FORBIDDEN',
        subject: key,
        message: `${key} is set, so beta could deliver real messages to real recipients.`,
        remedy: `Leave ${key} empty — with no delivery provider configured, invitations are surfaced locally instead of sent.`
      });
    }
  }

  for (const port of probes.portsInUse ?? []) {
    problems.push({
      code: 'BETA_PORT_IN_USE',
      subject: String(port),
      message: `Port ${port} is already held by another process.`,
      remedy: `Stop whatever is listening on ${port}, or run \`npm run beta:down\` if a previous beta run is still up.`
    });
  }

  for (const prerequisite of probes.missingPrerequisites ?? []) {
    problems.push({
      code: 'BETA_PREREQUISITE_MISSING',
      subject: prerequisite,
      message: `${prerequisite} was not found.`,
      remedy: `Install or start ${prerequisite} before bringing beta up.`
    });
  }

  return problems;
}

/**
 * Guards the reset. A reset that could reach a non-local database is the one
 * operation in this feature that could destroy production data, so the check
 * is expressed here and must run before the first destructive step.
 */
export function evaluateResetTarget(target: string | undefined | null): BetaGuardProblem | null {
  const value = (target ?? '').trim();
  if (!value) return null;
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return {
      code: 'BETA_RESET_TARGET_UNSAFE',
      subject: 'SUPABASE_DB_URL',
      message: `The reset target ${JSON.stringify(value)} could not be parsed as a URL.`,
      remedy: 'Unset SUPABASE_DB_URL so the reset uses the local stack, or point it at 127.0.0.1.'
    };
  }
  if (isLoopbackOrigin(value)) return null;
  return {
    code: 'BETA_RESET_TARGET_UNSAFE',
    subject: 'SUPABASE_DB_URL',
    message: `The reset target ${hostname} is not on this machine.`,
    remedy:
      'Refusing to reset a non-local database. Unset SUPABASE_DB_URL or point it at 127.0.0.1.'
  };
}
