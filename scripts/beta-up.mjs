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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { BETA_PROFILE } from '../packages/shared/dist/environment.js';
import { parseEnvFile } from './verify-beta-env.mjs';

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
const environment = { ...process.env, ...profile, SOTY_ENVIRONMENT: 'beta' };

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

const stack = spawnSync('npx', ['supabase', 'start'], { shell: false, stdio: 'inherit' });
if (stack.status !== 0) fail('the local Supabase stack did not start.');

start('agent', process.execPath, ['apps/agent/dist/index.js']);
start('web', 'npx', [
  'vite',
  '--mode',
  'beta',
  '--host',
  '127.0.0.1',
  '--port',
  String(BETA_PROFILE.webPort),
  '--strictPort',
  'apps/web'
]);

process.stdout.write(
  `\nBeta is up.\n` +
    `  Web:   http://127.0.0.1:${BETA_PROFILE.webPort}\n` +
    `  Agent: http://127.0.0.1:${BETA_PROFILE.agentPort}\n` +
    `  Stop with: npm run beta:down (or Ctrl-C here)\n`
);
