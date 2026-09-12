import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { execute } from './execute.mjs';
import { stepDefinition } from './steps.mjs';
import { applyBackendPlan } from './adapters/backend.mjs';
import { rehearseBackendBeta } from './adapters/backend-beta.mjs';

const exec = promisify(execFile);

/**
 * The step adapter: what each registry step actually does.
 *
 * Everything here is a command the production runbook already tells a person to
 * type, in the order it tells them to type it. That is deliberate. The value of
 * this file is not a cleverer release — it is that the sequence, the waiting and
 * the bookkeeping stop depending on somebody not losing their place halfway
 * through a four-phase checklist on a laptop that keeps running out of memory.
 *
 * Two rules shape every entry:
 *
 *   - Commands run through `execute()`, so each one is `nice`d, has its output
 *     bounded and redacted, and passes through resource admission. Nothing here
 *     spawns a bare child process.
 *   - A step reports `{ok:false}` with a code; it never throws its way out and
 *     never "fixes" anything on its own. The worker owns what happens next,
 *     because it is the only thing holding the journal.
 */

/** Commands that change the outside world and must not be re-run casually. */
const REMOTE_STEPS = new Set(['publish', 'manifest', 'backend_apply', 'deploy']);

function fail(code, subject) {
  return { ok: false, error: { code, subject } };
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The code a thrown adapter error carries, when it carries one. */
function codeOf(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
}

/**
 * Runs one command and turns its exit status into a step result.
 *
 * The step's own timeout comes from the resource profile rather than a number
 * invented here, so raising an estimate after a slow run lengthens the deadline
 * and the reservation together.
 */
async function run(stepId, argv, { cwd, env = {}, admission = null }) {
  const step = stepDefinition(stepId);
  const result = await execute(argv, {
    cwd,
    env,
    timeoutMs: step.timeoutMs,
    admission
  });
  if (result.ok) return { ok: true, output: result.output };
  if (result.code === 'RESOURCE_WAIT') return fail('RESOURCE_WAIT', 'the machine was not admitted');
  return fail(
    result.timedOut ? 'STEP_TIMEOUT' : 'GATE_FAILED',
    `${argv.join(' ')} — ${result.output.slice(-3).join(' ').trim() || `exit ${result.code}`}`
  );
}

const npm = (...args) => ['npm', 'run', ...args];

/**
 * Locates the workflow run a dispatch just created.
 *
 * `gh workflow run` does not return a run id, which is why the runbook tells a
 * person to go and look it up. The correlation is the source SHA plus the
 * dispatch time: a run older than the dispatch belongs to somebody else.
 */
async function findWorkflowRun({ cwd, workflow, sourceSha, dispatchedAt }) {
  const { stdout } = await exec(
    'gh',
    ['run', 'list', '--workflow', workflow, '--limit', '10', '--json',
     'databaseId,headSha,createdAt,status,conclusion'],
    { cwd, shell: false }
  );
  const candidates = JSON.parse(stdout)
    .filter(candidate => candidate.headSha === sourceSha)
    .filter(candidate => Date.parse(candidate.createdAt) >= dispatchedAt - 60_000)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return candidates[0] ?? null;
}

async function dispatchAndWatch(stepId, { cwd, env, admission, sourceSha, releaseId, publish }) {
  const workflow = 'release-windows.yml';
  const dispatchedAt = Date.now();
  try {
    await exec(
      'gh',
      ['workflow', 'run', workflow, '--ref', 'main',
       '-f', `publish=${publish}`, '-f', `source_sha=${sourceSha}`, '-f', `release_id=${releaseId}`],
      { cwd, shell: false }
    );
  } catch (error) {
    return fail('ACCESS_UNAVAILABLE', `gh workflow run failed: ${messageOf(error)}`);
  }
  // The dispatch may have started a run even if finding it fails, so a lookup
  // failure is ambiguous rather than a clean "nothing happened".
  const found = await findWorkflowRun({ cwd, workflow, sourceSha, dispatchedAt });
  if (!found)
    return fail('EFFECT_AMBIGUOUS', `dispatched ${workflow} for ${sourceSha} but no run was found`);
  return run(stepId, [process.execPath, 'scripts/watch-github-run.mjs', String(found.databaseId)], {
    cwd,
    env,
    admission
  });
}

/**
 * Builds the executor the worker drives.
 *
 * @param {{
 *   runId: string,
 *   version: string,
 *   sourceSha: string,
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   binding: {bindingId: string, kind: string},
 *   backendPlan?: {changes: readonly object[]} | null,
 *   backendAdapter?: object | null,
 *   journal?: {flush: (receipt: object) => Promise<void>} | null,
 *   admission?: object | null,
 *   allowRemote?: boolean
 * }} options
 */
export async function createStepAdapter({
  runId,
  version,
  sourceSha,
  cwd = process.cwd(),
  env = {},
  binding,
  backendPlan = null,
  backendAdapter = null,
  journal = null,
  admission = null,
  allowRemote = true
}) {
  if (!version || !/^[a-f0-9]{40}$/u.test(sourceSha ?? ''))
    throw new Error('STEP_ADAPTER_IDENTITY_INVALID');
  if (!binding?.bindingId) throw new Error('STEP_ADAPTER_BINDING_MISSING');

  const releaseId = `${runId}:${version}`;
  const dmg = path.join('release', `Soty-v${version}-macOS-arm64.dmg`);
  const exe = path.join('release', 'windows', `download-${version}`, `Soty-v${version}-Windows-x64.exe`);
  // The binding travels into every child, so a sandbox release reaches sandbox
  // destinations without any command here naming one.
  const childEnv = { ...env, SOTY_RELEASE_RUN_ID: runId };

  const steps = {
    /**
     * Preflight reads: the local build environment, then the live project.
     *
     * The second half is the one that was missing. Everything before it can
     * pass on a machine whose code is perfect and a project that is missing the
     * secret, function or migration that code needs — and the first thing to
     * notice would be a user meeting a 503. Declared migrations are named so a
     * release that intends to apply them is not mistaken for drift.
     */
    preflight: async () => {
      const webEnv = await run('preflight', [process.execPath, 'scripts/verify-web-env.mjs'], {
        cwd,
        env: childEnv,
        admission: null
      });
      if (!webEnv.ok) return webEnv;
      // The live half is a remote read. A dry configuration walks the whole
      // sequence without touching anything outside this machine, so it stops
      // here rather than reaching for a project it was told not to contact.
      if (!allowRemote) return webEnv;
      const pending = (backendPlan?.changes ?? [])
        .filter(change => change.kind === 'migration')
        .map(change => change.id);
      return run(
        'preflight',
        [
          process.execPath,
          'scripts/verify-production-config.mjs',
          ...(pending.length ? [`--expect-pending=${pending.join(',')}`] : [])
        ],
        { cwd, env: childEnv, admission: null }
      );
    },

    prepare: () => run('prepare', npm('build', '-w', '@video-compressor/shared'), { cwd, env: childEnv, admission }),

    candidate_gate: () => run('candidate_gate', npm('release:check'), { cwd, env: childEnv, admission }),

    beta_package: () => run('beta_package', npm('beta:package'), { cwd, env: childEnv, admission }),

    beta_verify: () => run('beta_verify', npm('beta:verify'), { cwd, env: childEnv, admission }),

    backend_beta: async () => {
      if (!backendPlan?.changes?.length) return { ok: true, skipped: true };
      if (!backendAdapter) return fail('ACCESS_UNAVAILABLE', 'no backend adapter is configured');
      try {
        const result = await rehearseBackendBeta({
          binding,
          plan: backendPlan,
          lease: { leaseId: `${runId}:backend-beta` },
          adapter: backendAdapter
        });
        return result.ok ? { ok: true } : fail('GATE_FAILED', `backend rehearsal failed: ${result.error}`);
      } catch (error) {
        return fail('TARGET_MISMATCH', messageOf(error));
      }
    },

    readiness: () => run('readiness', [process.execPath, 'scripts/verify-beta-promotion.mjs'], { cwd, env: childEnv, admission }),

    macos_package: async () => {
      const built = await run('macos_package', npm('package:mac'), { cwd, env: childEnv, admission });
      if (!built.ok) return built;
      return run('macos_package', npm('package:dmg'), { cwd, env: childEnv, admission });
    },

    windows_smoke: () =>
      dispatchAndWatch('windows_smoke', { cwd, env: childEnv, admission, sourceSha, releaseId, publish: false }),

    publish: async () => {
      if (!existsSync(path.join(cwd, dmg))) return fail('GATE_FAILED', `${dmg} was not built`);
      // An existing release is not an error to overwrite: it is evidence this
      // step already ran. Creating it twice is what must never happen.
      const existing = await exec('gh', ['release', 'view', `v${version}`, '--json', 'assets'], { cwd, shell: false })
        .then(({ stdout }) => JSON.parse(stdout))
        .catch(() => null);
      if (!existing) {
        try {
          await exec('gh', ['release', 'create', `v${version}`, dmg, '--title', `Soty v${version}`, '--notes-file', 'RELEASE_NOTES.md'], { cwd, shell: false });
        } catch (error) {
          return fail('EFFECT_AMBIGUOUS', `gh release create failed: ${messageOf(error)}`);
        }
      }
      return dispatchAndWatch('publish', { cwd, env: childEnv, admission, sourceSha, releaseId, publish: true });
    },

    manifest: async () => {
      if (!existsSync(path.join(cwd, exe))) {
        const downloaded = await run('manifest',
          ['gh', 'release', 'download', `v${version}`, '--pattern', `Soty-v${version}-Windows-x64.exe`, '--dir', path.dirname(exe)],
          { cwd, env: childEnv, admission });
        if (!downloaded.ok) return downloaded;
      }
      for (const [file, platform] of [[dmg, 'macos-arm64'], [exe, 'windows-x64']]) {
        const signed = await run('manifest',
          [process.execPath, 'scripts/sign-release-manifest.mjs', '--dmg', file, '--platform', platform],
          { cwd, env: childEnv, admission });
        if (!signed.ok) return signed;
      }
      return run('manifest', [process.execPath, 'scripts/verify-published-release.mjs'], { cwd, env: childEnv, admission });
    },

    manifest_beta_verify: async () => {
      const packaged = await run('manifest_beta_verify', npm('beta:package'), { cwd, env: childEnv, admission });
      if (!packaged.ok) return packaged;
      return run('manifest_beta_verify', npm('beta:verify'), { cwd, env: childEnv, admission });
    },

    backend_apply: async () => {
      if (!backendPlan?.changes?.length) return { ok: true, skipped: true };
      if (!backendAdapter || !journal)
        return fail('ACCESS_UNAVAILABLE', 'no backend adapter or journal is configured');
      try {
        const result = await applyBackendPlan({ binding, plan: backendPlan, sourceSha, adapter: backendAdapter, journal });
        return result.ok ? { ok: true } : fail('GATE_FAILED', 'backend apply did not complete');
      } catch (error) {
        return fail(codeOf(error) ?? 'GATE_FAILED', messageOf(error));
      }
    },

    deploy: () => run('deploy', npm('deploy:web'), { cwd, env: childEnv, admission }),

    live_verify: () => run('live_verify', [process.execPath, 'scripts/verify-published-release.mjs'], { cwd, env: childEnv, admission })
  };

  return {
    async execute(stepId) {
      const step = steps[stepId];
      if (!step) return fail('INTENT_INVALID', `no adapter for release step ${stepId}`);
      // A dry configuration can walk the whole sequence without touching
      // anything outside this machine, which is how the ordering is exercised
      // before real credentials exist.
      if (!allowRemote && REMOTE_STEPS.has(stepId))
        return fail('ACCESS_UNAVAILABLE', `${stepId} needs remote access, which this run disallows`);
      return step();
    }
  };
}
