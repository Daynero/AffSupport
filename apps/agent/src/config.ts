import {
  BUILD_ID,
  BUILD_NUMBER,
  PREVIEW_SITE_ORIGIN,
  PRODUCTION_BACKEND_ORIGIN,
  PRODUCTION_SITE_ORIGIN,
  PRODUCT_VERSION,
  RELEASE_CHANNEL,
  evaluateBetaEnvironment,
  parseAppEnvironment,
  type AppEnvironment
} from '@video-compressor/shared';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 43120;

function releaseValue(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function appEnvironment(): AppEnvironment {
  const parsed = parseAppEnvironment(process.env.SOTY_ENVIRONMENT);
  if (!parsed.ok) throw new Error(`SOTY_ENVIRONMENT is invalid: ${parsed.error}`);
  return parsed.value;
}

function validOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL origin.`);
  }
  if (url.origin !== value || (url.protocol !== 'https:' && url.hostname !== '127.0.0.1'))
    throw new Error(`${label} must be an HTTPS origin (or 127.0.0.1 for development).`);
  return value;
}

const environment = appEnvironment();

/**
 * Where the agent's own background calls go: native restitch and catalog video
 * recovery, which run with no browser tab to name the backend. A beta agent is
 * pinned to the local stack; production uses the hosted project the web build
 * is paired with. SOTY_BACKEND_ORIGIN overrides it for development against
 * another local stack, and a beta agent may never be pointed off this machine.
 */
function backendOrigin(): string {
  const override = process.env.SOTY_BACKEND_ORIGIN?.trim();
  if (override) {
    const origin = validOrigin(override, 'SOTY_BACKEND_ORIGIN');
    if (environment === 'beta' && new URL(origin).hostname !== '127.0.0.1')
      throw new Error('SOTY_BACKEND_ORIGIN must stay on 127.0.0.1 for a beta agent.');
    return origin;
  }
  return environment === 'beta' ? 'http://127.0.0.1:54321' : PRODUCTION_BACKEND_ORIGIN;
}

export const config = {
  environment,
  backendOrigin: backendOrigin(),
  host: DEFAULT_HOST,
  port: Number(process.env.AGENT_PORT ?? DEFAULT_PORT),
  publicOrigin: process.env.PUBLIC_SITE_ORIGIN
    ? validOrigin(process.env.PUBLIC_SITE_ORIGIN, 'PUBLIC_SITE_ORIGIN')
    : null,
  devOrigin: validOrigin(process.env.DEV_SITE_ORIGIN ?? 'http://127.0.0.1:5173', 'DEV_SITE_ORIGIN'),
  version: releaseValue('AGENT_VERSION', PRODUCT_VERSION),
  buildNumber: releaseValue('AGENT_BUILD_NUMBER', BUILD_NUMBER),
  buildId: releaseValue('AGENT_BUILD_ID', BUILD_ID),
  channel: releaseValue('AGENT_RELEASE_CHANNEL', RELEASE_CHANNEL),
  sourceRevision: releaseValue('AGENT_SOURCE_REVISION', 'development'),
  nativeStartupId: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
    process.env.AGENT_NATIVE_STARTUP_ID ?? ''
  )
    ? process.env.AGENT_NATIVE_STARTUP_ID!.toLowerCase()
    : null,
  installedReleasePath: process.env.AGENT_INSTALLED_RELEASE_PATH?.trim() || null
};
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
  throw new Error('AGENT_PORT must be a port from 1024 to 65535.');

/**
 * A beta agent must never reach production. The check runs here, at module
 * load, so a misconfigured beta process fails before `buildServer` — it never
 * binds a port and never accepts a request. Only the settings this process
 * actually owns are checked; the doctor script covers the rest of the profile.
 */
if (config.environment === 'beta') {
  const problems = evaluateBetaEnvironment(
    {
      SOTY_ENVIRONMENT: 'beta',
      PUBLIC_SITE_ORIGIN: config.publicOrigin ?? '',
      DEV_SITE_ORIGIN: config.devOrigin,
      AGENT_ENTITLEMENT_PUBLIC_KEY: process.env.AGENT_ENTITLEMENT_PUBLIC_KEY ?? ''
    },
    {}
  ).filter(problem =>
    ['PUBLIC_SITE_ORIGIN', 'DEV_SITE_ORIGIN', 'AGENT_ENTITLEMENT_PUBLIC_KEY'].includes(
      problem.subject
    )
  );
  if (problems.length) {
    const detail = problems.map(problem => `${problem.code}: ${problem.message}`).join(' ');
    throw new Error(`The beta agent refuses to start. ${detail}`);
  }
}
// Both spellings of the local copy. The agent listens on 127.0.0.1 and the same socket is
// reached as `localhost`; a browser at one of them is the same page as at the other, and
// refusing the second turned every POST from a `localhost` bookmark into a 403.
//
// 051: a production agent also trusts the candidate address. It is the same
// production -- the owner tests a release there on real data before promoting
// it byte for byte -- and is added only when this agent's public origin is the
// production site, so a beta or development agent never learns it.
export function originsFor(input: {
  devOrigin: string;
  publicOrigin: string | null;
  host: string;
  port: number;
}): Set<string> {
  return new Set(
    [
      input.devOrigin,
      input.publicOrigin,
      input.publicOrigin === PRODUCTION_SITE_ORIGIN ? PREVIEW_SITE_ORIGIN : null,
      `http://${input.host}:${input.port}`,
      `http://localhost:${input.port}`
    ].filter((value): value is string => Boolean(value))
  );
}
export const allowedOrigins = originsFor(config);
