/**
 * Beta environment doctor.
 *
 * Runs before anything starts and answers one question: is this machine ready
 * to run a beta copy that cannot reach production? Every problem is reported in
 * one pass with a remedy, because a first run with three things missing should
 * cost one fix cycle rather than three.
 *
 * The rules themselves live in @video-compressor/shared (evaluateBetaEnvironment)
 * so the agent's startup assertion and the tests share them. This file owns only
 * the I/O: reading the profile, probing ports and prerequisites, asking git.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import {
  BETA_LOCAL_STACK_PORTS,
  BETA_PROFILE,
  evaluateBetaEnvironment
} from '../packages/shared/dist/environment.js';

const PROFILE_FILE = '.env.beta';

function fail(message) {
  process.stderr.write(`Beta environment check failed: ${message}\n`);
  process.exit(1);
}

/** Parses a dotenv-style file into a plain object. Values are not expanded. */
export function parseEnvFile(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return result;
}

function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, { shell: false, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function containerRuntimeRunning() {
  // `docker info` succeeds only when a daemon is actually reachable, which is
  // what `supabase start` needs — mere presence of the binary is not enough.
  const result = spawnSync('docker', ['info'], { shell: false, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function portFree(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    // Bind the same loopback address the beta services use, so the probe
    // reflects the address that will actually be claimed.
    server.listen(port, '127.0.0.1');
  });
}

function git(args, fallback = null) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return fallback;
  }
}

function productionEntitlementKey() {
  if (!existsSync('config/production.env')) return null;
  return (
    parseEnvFile(readFileSync('config/production.env', 'utf8')).AGENT_ENTITLEMENT_PUBLIC_KEY ?? null
  );
}

async function main() {
  if (!existsSync(PROFILE_FILE)) {
    fail(
      `BETA_ENV_MISSING: ${PROFILE_FILE} does not exist.\n` +
        `  Remedy: cp .env.beta.example ${PROFILE_FILE}, then fill in the values it names.`
    );
  }

  // Process environment wins over the file, matching the precedence in
  // contracts/beta-environment-contract.md, so a one-off override is honoured
  // and — importantly — is still checked rather than bypassing the guard.
  const profile = { ...parseEnvFile(readFileSync(PROFILE_FILE, 'utf8')) };
  for (const key of Object.keys(profile)) {
    const override = process.env[key];
    if (typeof override === 'string' && override.trim()) profile[key] = override.trim();
  }
  for (const key of ['RESEND_API_KEY', 'INVITE_EMAIL_FROM', 'VITE_LOCAL_DEV_AUTH']) {
    const override = process.env[key];
    if (typeof override === 'string' && override.trim()) profile[key] = override.trim();
  }

  const missingPrerequisites = [];
  if (!containerRuntimeRunning()) {
    missingPrerequisites.push('a running container runtime (Docker Desktop or equivalent)');
  }
  if (!commandAvailable('npx', ['supabase', '--version'])) {
    missingPrerequisites.push('the Supabase CLI (npx supabase)');
  }
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (!commandAvailable(tool, ['-version'])) missingPrerequisites.push(tool);
  }

  const ports = [BETA_PROFILE.agentPort, BETA_PROFILE.webPort, ...BETA_LOCAL_STACK_PORTS];
  const portsInUse = [];
  for (const port of ports) {
    if (!(await portFree(port))) portsInUse.push(port);
  }

  const problems = evaluateBetaEnvironment(profile, {
    portsInUse,
    missingPrerequisites,
    productionEntitlementKey: productionEntitlementKey()
  });

  if (problems.length) {
    process.stderr.write('Beta environment check failed:\n');
    for (const problem of problems) {
      process.stderr.write(`  ${problem.code} (${problem.subject}): ${problem.message}\n`);
      process.stderr.write(`    Remedy: ${problem.remedy}\n`);
    }
    process.exit(1);
  }

  // FR-011: the maintainer must know which code this copy will run and how far
  // the beta line trails production, so a stale beta cannot be mistaken for a
  // current one and produce false conclusions.
  const revision = git(['rev-parse', '--short=12', 'HEAD'], 'unknown');
  const dirty = git(['status', '--porcelain'], '') ? ' (uncommitted changes present)' : '';
  const behind = git(['rev-list', '--count', 'HEAD..main'], null);

  process.stdout.write(
    `Beta environment ready.\n` +
      `  Source revision: ${revision}${dirty}\n` +
      `  Behind main: ${behind === null ? 'unknown (no main branch found)' : `${behind} commit(s)`}\n` +
      `  Agent: http://127.0.0.1:${BETA_PROFILE.agentPort}  Web: http://127.0.0.1:${BETA_PROFILE.webPort}\n` +
      `  Loopback only — nothing is bound to an externally reachable address.\n`
  );
}

await main();
