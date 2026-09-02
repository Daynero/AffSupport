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
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { BETA_LOCAL_STACK_PORTS, BETA_PROFILE } from '../packages/shared/dist/environment.js';
import { parseEnvFile } from './verify-beta-env.mjs';
import { workerSecretStatements } from './lib/beta-worker-secrets.mjs';

// Colima is the documented macOS runtime. Starting an existing instance is
// idempotent and turns the common "Docker is installed but not running" case
// into a normal beta startup instead of a manual recovery step.
const docker = spawnSync('docker', ['info'], { shell: false, stdio: 'ignore' });
if (docker.status !== 0) {
  const colima = spawnSync('colima', ['start'], { shell: false, stdio: 'inherit' });
  // A spawn failure carries an errno; `Error` does not declare one.
  if (/** @type {NodeJS.ErrnoException | undefined} */ (colima.error)?.code === 'ENOENT') {
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

// `supabase start` exits 0 even when it gave up on a service that failed its
// health check, printing "Stopped services: [...]" and carrying on. When that
// service is the edge runtime, every server-side team feature -- Drive connect,
// Drive ops, library ops, invitations, catalog sync, entitlement -- answers 503
// while beta still reports itself up, which is the worst possible outcome for a
// verification environment: the product looks broken rather than unstarted.
//
// So prove the runtime is serving before claiming beta is up, and restart it
// once if the CLI stopped it. The probe asks for a function that does not exist:
// a served runtime answers it (404/401/403), a dead one is unreachable through
// Kong.
const [functionsPort] = BETA_LOCAL_STACK_PORTS;

async function edgeRuntimeServing() {
  try {
    const response = await fetch(
      `http://127.0.0.1:${functionsPort}/functions/v1/beta-readiness-probe`,
      { method: 'POST', signal: AbortSignal.timeout(5000) }
    );
    // 503 is Kong reporting it cannot reach the runtime at all. Anything else
    // means an isolate answered, which is all this probe needs to establish.
    return response.status !== 503;
  } catch {
    return false;
  }
}

async function requireEdgeFunctions() {
  const deadline = Date.now() + 60_000;
  let restarted = false;
  while (Date.now() < deadline) {
    if (await edgeRuntimeServing()) {
      await requireEveryFunctionBoots();
      return;
    }
    if (!restarted) {
      restarted = true;
      process.stdout.write('Edge runtime is not serving; restarting it.\n');
      spawnSync('docker', ['start', `supabase_edge_runtime_${projectId()}`], {
        shell: false,
        stdio: 'ignore'
      });
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  fail(
    'the local Supabase edge runtime is not serving, so every server-side team ' +
      'feature would answer 503. Check `docker logs supabase_edge_runtime_' +
      `${projectId()}\`.`
  );
}

/** Every deployable function directory: `_shared` holds modules, not functions. */
function functionNames() {
  return readdirSync('supabase/functions', { withFileTypes: true })
    .filter(
      entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')
    )
    .map(entry => entry.name)
    .sort();
}

/**
 * Boots each function once and refuses to report beta up while any of them
 * cannot start.
 *
 * A serving runtime is not the same as a working function: the local stack
 * bind-mounts one file per module of each function's import graph, resolved
 * when the stack starts, so a shared module added afterwards makes that
 * function -- and only that one -- answer 503 `BOOT_ERROR` forever. The
 * readiness probe above asks for a function that does not exist, which a broken
 * drive-ops passes happily; the product then looks broken in team mode ("the
 * server answered unexpectedly") with nothing in the startup output to say why.
 *
 * Unauthenticated is on purpose: every function refuses such a call (401/403/
 * 400/303) after its worker has booted, so the status only has to not be 503.
 *
 * The redirect is deliberately not followed. `drive-oauth-callback` refuses with a 303 back
 * to the web app, which is not listening yet at this point in startup — following it made the
 * probe report "fetch failed" and fail a stack whose functions had all booted perfectly well.
 * A redirect *is* the answer this probe is looking for.
 */
async function requireEveryFunctionBoots() {
  const names = functionNames();
  const failures = [];
  await Promise.all(
    names.map(async name => {
      try {
        const response = await fetch(`http://127.0.0.1:${functionsPort}/functions/v1/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000)
        });
        if (response.status !== 503) return;
        const body = await response.text().catch(() => '');
        // A 503 carrying the team error envelope came from the function itself
        // (a refusal it chose), which is proof enough that its worker booted.
        // A boot failure answers with the runtime's own `{"code":"BOOT_ERROR"}`.
        try {
          const parsed = JSON.parse(body);
          if (parsed?.ok === false && parsed?.error) return;
        } catch {
          // Not JSON: treat as a boot failure and report the body below.
        }
        failures.push(`${name}: ${body.slice(0, 300) || '503 with no body'}`);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );
  if (failures.length === 0) return;
  fail(
    `these edge functions cannot boot, so the features behind them would answer 503:\n  ` +
      `${failures.join('\n  ')}\n` +
      'A "Module not found" boot error usually means a shared module appeared after ' +
      'the stack started; `npm run beta:down && npm run beta:up` remounts them.'
  );
}

function projectId() {
  const config = readFileSync('supabase/config.toml', 'utf8');
  return /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1] ?? 'wishly';
}

/**
 * Makes the scheduled Drive workers runnable on this machine.
 *
 * Written on every start rather than once, because the rows live in the database and any
 * reset takes them with it — see `scripts/lib/beta-worker-secrets.mjs` for what that failure
 * looks like from the outside.
 */
function seedWorkerSecrets() {
  const statements = workerSecretStatements(functionsRuntimeEnv);
  if (statements.length === 0) return;
  const result = spawnSync(
    'docker',
    ['exec', '-i', `supabase_db_${projectId()}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-q'],
    { shell: false, input: statements.join('\n'), encoding: 'utf8' }
  );
  if (result.status !== 0) {
    // Not fatal: the stack is usable, only the background scan is not. Said plainly rather
    // than left to be discovered as "the last sync failed" a quarter of an hour later.
    process.stdout.write(
      'Warning: could not seed the worker secrets; Drive scanning will not run.\n'
    );
  }
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
await requireEdgeFunctions();
seedWorkerSecrets();

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
