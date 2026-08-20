/**
 * Brings the whole beta environment up with one command.
 *
 * The doctor runs first and must pass: nothing is started before the
 * prerequisites and the isolation guard are known good, so a missing container
 * runtime produces a named message rather than a half-started environment.
 *
 * Children are spawned with an argument array and `shell: false`, tracked by
 * PID, and torn down together — the agent's own orchestration discipline
 * applied to the orchestrator.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { BETA_PROFILE } from '../packages/shared/dist/environment.js';
import { parseEnvFile } from './verify-beta-env.mjs';

// Colima is the documented macOS runtime. Starting an existing instance is
// idempotent and turns the common "Docker is installed but not running" case
// into a normal beta startup instead of a manual recovery step.
const docker = spawnSync('docker', ['info'], { shell: false, stdio: 'ignore' });
if (docker.status !== 0) {
  const colima = spawnSync('colima', ['start'], { shell: false, stdio: 'inherit' });
  if (colima.error?.code === 'ENOENT') {
    // The doctor below reports the platform-neutral prerequisite and remedy.
  }
}

function fail(message) {
  process.stderr.write(`Beta start failed: ${message}\n`);
  process.exit(1);
}

const doctor = spawnSync(process.execPath, ['scripts/verify-beta-env.mjs'], {
  shell: false,
  stdio: 'inherit'
});
if (doctor.status !== 0) fail('the environment check did not pass; nothing was started.');

const profile = existsSync('.env.beta') ? parseEnvFile(readFileSync('.env.beta', 'utf8')) : {};
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore']
}).trim();
// The shared package's compiled release constants intentionally describe the
// stable product. Override the runtime handshake here so a source-run beta
// cannot identify itself as stable or report the development placeholder.
const environment = {
  ...process.env,
  ...profile,
  SOTY_ENVIRONMENT: 'beta',
  AGENT_RELEASE_CHANNEL: 'beta',
  AGENT_SOURCE_REVISION: sourceRevision,
  // This command serves the beta UI from Vite. Pairing must return to that
  // origin; `.env.beta` keeps the Agent's own origin for packaged-beta builds.
  PUBLIC_SITE_ORIGIN: profile.VITE_SITE_URL
};

const children = [];

function start(label, command, args) {
  const child = spawn(command, args, { shell: false, stdio: 'inherit', env: environment });
  child.on('error', error => fail(`${label} could not start: ${error.message}`));
  child.on('exit', code => {
    if (code !== 0 && !shuttingDown) {
      process.stderr.write(`Beta ${label} exited with code ${code}.\n`);
      shutdown(code ?? 1);
    }
  });
  children.push({ label, child });
  return child;
}

let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  // Escalate rather than hang if a child ignores SIGTERM. The timer is unref'd
  // so it never keeps this process alive on its own.
  const escalation = setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    process.exit(code);
  }, 5_000);
  escalation.unref();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Supabase's local edge runtime reads `supabase/functions/.env`, while the
// beta setup deliberately keeps local secrets in `.env.local`. Mirror the
// latter immediately before startup so entitlement and other Functions always
// receive the same beta-only configuration. Both paths are git-ignored.
const functionsLocalEnv = 'supabase/functions/.env.local';
const functionsRuntimeEnv = 'supabase/functions/.env';
if (existsSync(functionsLocalEnv)) {
  const alreadySameFile =
    existsSync(functionsRuntimeEnv) &&
    realpathSync(functionsRuntimeEnv) === realpathSync(functionsLocalEnv);
  if (!alreadySameFile) copyFileSync(functionsLocalEnv, functionsRuntimeEnv);
}

const stack = spawnSync('npx', ['supabase', 'start'], { shell: false, stdio: 'inherit' });
if (stack.status !== 0) fail('the local Supabase stack did not start.');

start('agent', process.execPath, ['apps/agent/dist/index.js']);
// Run through the web workspace so npm resolves that workspace's pinned Vite
// version. Invoking `npx vite` from the repository root can pick Vitest's
// transitive Vite instead, which is incompatible with the web React plugin.
start('web', 'npm', ['run', 'dev:beta', '--workspace', '@video-compressor/web']);

process.stdout.write(
  `\nBeta is up.\n` +
    `  Web:   http://127.0.0.1:${BETA_PROFILE.webPort}\n` +
    `  Agent: http://127.0.0.1:${BETA_PROFILE.agentPort}\n` +
    `  Stop with: npm run beta:down (or Ctrl-C here)\n`
);
