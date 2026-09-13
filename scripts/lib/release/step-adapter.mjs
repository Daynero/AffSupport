import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { execute } from './execute.mjs';
import { stepDefinition } from './steps.mjs';
import { applyBackendPlan } from './adapters/backend.mjs';
import { rehearseBackendBeta } from './adapters/backend-beta.mjs';
import { createSupabaseBackendAdapter } from './adapters/supabase-backend.mjs';
import { commitKnownFiles, promoteBeta, remoteBetaSha } from './adapters/git.mjs';

const exec = promisify(execFile);

/** The one file a release rewrites after its artifacts exist. */
const MANIFEST_PATH = 'apps/web/public/.well-known/wishly/stable.json';

/**
 * The committed half of the release environment.
 *
 * The runbook opens by telling a person to `set -a` and source these two files,
 * and everything after that assumes they did. An agent driving the same sequence
 * has no shell that was ever sourced into, so `package:mac` stopped on the first
 * thing it needs -- `PUBLIC_SITE_ORIGIN` -- with the runbook's own error message.
 * A requirement that lives in prose is not installed.
 *
 * They are read from the checkout being released, not from this one, and they
 * win over the surrounding shell: the origin baked into an artifact should come
 * from the commit that artifact is built from, not from what somebody exported
 * an hour ago. Both files are tracked and hold no secrets -- origins, a port, a
 * public key, and the web client's publishable values.
 */
const RELEASE_ENV_FILES = Object.freeze(['config/production.env', 'apps/web/.env.production']);

function releaseEnvironment(cwd) {
  const loaded = {};
  for (const relative of RELEASE_ENV_FILES) {
    const file = path.join(cwd, relative);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
      if (!match) continue;
      loaded[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/u, '$2');
    }
  }
  return loaded;
}


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

/**
 * Where a rehearsal is allowed to happen: the local beta stack, never a
 * destination that serves anybody. Declared as a binding so the rehearsal is
 * refused by the same check that refuses every other misdirected write.
 */
const BETA_REHEARSAL = Object.freeze({ kind: 'sandbox', bindingId: 'beta-local' });

/**
 * The release CLI token, from the environment or the untracked key file the
 * rest of the release reads. Absent, the backend steps report a blocker rather
 * than reaching for a project they cannot prove they may touch.
 */
function supabaseAccessToken(cwd) {
  if (process.env.SUPABASE_ACCESS_TOKEN?.trim()) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  try {
    return (
      /^SUPABASE_ACCESS_TOKEN=(.+)$/mu.exec(
        readFileSync(path.join(cwd, 'config/keys/supabase-release-cli.env'), 'utf8')
      )?.[1]?.trim() ?? null
    );
  } catch {
    return null;
  }
}

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
/**
 * Which of the workflow's runs is ours.
 *
 * It matched on `headSha`, and a dispatched run's head is the *ref it was
 * dispatched on*, never the commit it was asked to check out. That is the same
 * thing only when the release is the tip of `main` -- true of the last release
 * by accident, false of any release cut while development continues, which is
 * the case this runner exists for. So the dispatch succeeded, the build ran, and
 * the lookup returned nothing: `EFFECT_AMBIGUOUS`, a live Windows build nobody
 * was watching, and a release stopped for want of a name it already had.
 *
 * The workflow puts `release_id` in its own run name for exactly this purpose.
 * Correlating on it identifies the run we caused and no other, on any ref. The
 * head-sha match is kept as a fallback for runs started by a push, which carry
 * no release id.
 */
/**
 * Asking GitHub which runs exist, without that question being fatal.
 *
 * It is a read, so retrying it is free, and a release should not end because one
 * TLS handshake timed out on the way to an API -- which is exactly how one
 * attempt at this release ended. Only errors that read as transient are
 * retried; "not a git repository" is an answer, not a hiccup, and waiting nine
 * seconds to hear it again helps nobody.
 *
 * An exhausted lookup returns null rather than throwing. Before a dispatch that
 * means "nothing to adopt, go ahead"; after one it means the effect is
 * ambiguous, which is the truth and is what the step already says.
 */
const TRANSIENT = /timeout|timed out|TLS|handshake|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|502|503|rate limit/iu;

async function listWorkflowRuns({ cwd, workflow }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { stdout } = await exec(
        'gh',
        ['run', 'list', '--workflow', workflow, '--limit', '10', '--json',
         'databaseId,headSha,createdAt,status,conclusion,displayTitle'],
        { cwd, shell: false }
      );
      return JSON.parse(stdout);
    } catch (error) {
      if (attempt === 2 || !TRANSIENT.test(messageOf(error))) return null;
      await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
    }
  }
  return null;
}

async function findWorkflowRun({ cwd, workflow, sourceSha, releaseId, publish, dispatchedAt }) {
  const listed = await listWorkflowRuns({ cwd, workflow });
  if (!listed) return null;
  const runs = listed.filter(
    candidate => Date.parse(candidate.createdAt) >= dispatchedAt - 60_000
  );
  // The workflow names itself "Windows <release id> publish|build-only", so the
  // two dispatches one release makes are told apart as well as one release is
  // told from another.
  const mine = candidate =>
    candidate.displayTitle?.includes(releaseId) &&
    candidate.displayTitle.endsWith(publish ? 'publish' : 'build-only');
  const candidates = (
    releaseId && runs.some(mine) ? runs.filter(mine) : runs.filter(candidate => candidate.headSha === sourceSha)
  ).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return candidates[0] ?? null;
}

async function dispatchAndWatch(stepId, { cwd, env, admission, sourceSha, releaseId, publish }) {
  const workflow = 'release-windows.yml';
  const dispatchedAt = Date.now();

  /**
   * A run already under way for this release is the one to watch.
   *
   * The release id names one dispatch of one release, so a run carrying it was
   * caused by this step and no other. Dispatching a second one would not be a
   * retry: the workflow serialises on a concurrency group, so the duplicate
   * would queue behind the build already running and the release would wait out
   * both. Adopting it is the same rule `publish` already applies to a release
   * tag that exists -- evidence the effect happened, not a reason to repeat it.
   *
   * A run that failed or was cancelled is not adopted; that one does need doing
   * again.
   */
  const started = await findWorkflowRun({
    cwd,
    workflow,
    sourceSha,
    releaseId,
    publish,
    dispatchedAt: 0
  });
  if (started && !['failure', 'cancelled', 'timed_out'].includes(started.conclusion ?? ''))
    return run(stepId, [process.execPath, 'scripts/watch-github-run.mjs', String(started.databaseId)], {
      cwd,
      env,
      admission
    });

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
  /**
   * The run exists a moment after the dispatch returns, not at it.
   *
   * `gh workflow run` reports that GitHub accepted the request; creating the run
   * is asynchronous, and for the first few seconds `gh run list` does not show
   * it. Looking once, immediately, is therefore a coin toss -- and it landed
   * badly on a release whose Windows build was already compiling: the step
   * declared the effect ambiguous while the effect was on screen.
   *
   * So the step waits for the run it just asked for, up to a minute. A dispatch
   * that produced nothing at all still ends as ambiguous, which is the honest
   * answer: the request was accepted and nothing can be found.
   */
  let found = null;
  for (let attempt = 0; attempt < 10 && !found; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 6000));
    found = await findWorkflowRun({ cwd, workflow, sourceSha, releaseId, publish, dispatchedAt });
  }
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
 *   journal?: {append: (type: string, payload: unknown) => Promise<unknown>} | null,
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

  /**
   * The real Supabase adapter, unless a caller supplied one.
   *
   * Before this, nothing anywhere constructed a backend adapter, so every
   * release carrying a declared server change reached `backend_apply` and
   * reported ACCESS_UNAVAILABLE — the whole server half of the runbook was
   * wired up and inert, and the migrations went on being applied by hand.
   *
   * Construction does no I/O and reaches nothing remote; it only refuses an
   * unusable configuration, which the step then reports as the blocker it is.
   */
  const resolvedBackendAdapter =
    backendAdapter ??
    (() => {
      const projectRef = /** @type {{supabaseProject?: string}} */ (binding).supabaseProject;
      const token = supabaseAccessToken(cwd);
      if (!backendPlan?.changes?.length || !projectRef || !token) return null;
      try {
        return createSupabaseBackendAdapter({
          projectRef,
          targetId: binding.bindingId,
          root: cwd,
          accessToken: token
        });
      } catch {
        return null;
      }
    })();

  const releaseId = `${runId}:${version}`;
  const dmg = path.join('release', `Soty-v${version}-macOS-arm64.dmg`);
  const exe = path.join('release', 'windows', `download-${version}`, `Soty-v${version}-Windows-x64.exe`);
  // The binding travels into every child, so a sandbox release reaches sandbox
  // destinations without any command here naming one. The release environment is
  // read out of the checkout being released rather than out of whichever shell
  // started the run.
  const childEnv = { ...env, ...releaseEnvironment(cwd), SOTY_RELEASE_RUN_ID: runId };

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
      if (!resolvedBackendAdapter)
        return fail(
          'ACCESS_UNAVAILABLE',
          'no backend adapter: the release has server changes but no usable Supabase access'
        );
      try {
        const result = await rehearseBackendBeta({
          // Where the rehearsal happens is the beta stack; what the plan is for
          // is the release destination. Naming both keeps the check that the
          // changes are aimed where the release is aimed.
          binding: BETA_REHEARSAL,
          releaseTargetId: binding.bindingId,
          plan: backendPlan,
          lease: { leaseId: `${runId}:backend-beta` },
          adapter: resolvedBackendAdapter
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
          // `--target` is not optional. Without it `gh` creates the tag at the
          // default branch's tip, which during a release is wherever development
          // has got to -- so the tag would name commits the artifacts beside it
          // were not built from, and every later question ("what shipped in
          // 1.1.1?") would be answered with somebody else's work.
          await exec('gh', ['release', 'create', `v${version}`, dmg, '--target', sourceSha, '--title', `Soty v${version}`, '--notes-file', 'RELEASE_NOTES.md'], { cwd, shell: false });
        } catch (error) {
          return fail('EFFECT_AMBIGUOUS', `gh release create failed: ${messageOf(error)}`);
        }
      }
      // The tag exists on GitHub the moment the release does; it exists here
      // only if somebody fetches it. `deploy:web` requires it locally -- a
      // deployment must be able to name the artifacts it is advertising -- so a
      // release that created its own tag and never brought it home stopped one
      // step from shipping, with the tag visible in a browser.
      await exec('git', ['fetch', '--no-tags', 'origin', `refs/tags/v${version}:refs/tags/v${version}`], {
        cwd,
        shell: false
      }).catch(() => {});
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
      const published = await run('manifest', [process.execPath, 'scripts/verify-published-release.mjs'], { cwd, env: childEnv, admission });
      if (!published.ok) return published;

      /**
       * The signed manifest has to join the release line, not sit in a checkout.
       *
       * Signing rewrites `stable.json` with the digests of artifacts that did
       * not exist when the release was prepared. Left uncommitted it makes the
       * worktree dirty, and `deploy:web` refuses a dirty worktree -- so the
       * release would build everything, publish everything, and then decline to
       * ship on the grounds that it had modified itself.
       *
       * `commitKnownFiles` and `promoteBeta` were written for exactly this and
       * never called from anywhere, which is why no release had reached the step
       * that needed them. The commit moves the beta line with it, and
       * `manifest_beta_verify` then re-packages and re-verifies at that commit:
       * what ships is verified after the digests are recorded, not before.
       */
      const expectedBetaSha = await remoteBetaSha({ cwd, env: childEnv });
      await commitKnownFiles({
        cwd,
        files: [MANIFEST_PATH],
        message: `release: record ${version} artifact digests`,
        env: childEnv
      });
      /**
       * The commit may already exist, and the promotion may still be owed.
       *
       * A first attempt that committed the manifest and then failed to push
       * leaves the checkout ahead of `beta` with nothing left to commit. Keying
       * the promotion off "did I just commit" then skips it forever, and the
       * release ends with a beta line that does not contain what shipped. What
       * matters is where the two refs are, not which attempt moved them.
       */
      const { stdout: headSha } = await exec('git', ['rev-parse', 'HEAD'], { cwd, shell: false });
      const manifestSha = headSha.trim();
      if (manifestSha === expectedBetaSha) return { ok: true };
      const promoted = await promoteBeta({
        cwd,
        sourceSha: manifestSha,
        expectedBetaSha,
        env: childEnv
      });
      if (!promoted.ok)
        return fail(
          promoted.code === 'REMOTE_NOT_FAST_FORWARD' ? 'TARGET_MISMATCH' : 'EFFECT_AMBIGUOUS',
          `the manifest commit could not be promoted to beta: ${promoted.code}` +
            ('subject' in promoted && promoted.subject ? ` — ${promoted.subject}` : '')
        );
      // The promotion gate consults the local ref before the remote one, and
      // refs are shared with the checkout this worktree was cut from.
      await exec('git', ['update-ref', 'refs/heads/beta', manifestSha], { cwd, shell: false });
      return { ok: true };
    },

    manifest_beta_verify: async () => {
      const packaged = await run('manifest_beta_verify', npm('beta:package'), { cwd, env: childEnv, admission });
      if (!packaged.ok) return packaged;
      return run('manifest_beta_verify', npm('beta:verify'), { cwd, env: childEnv, admission });
    },

    backend_apply: async () => {
      if (!backendPlan?.changes?.length) return { ok: true, skipped: true };
      if (!resolvedBackendAdapter || !journal)
        return fail('ACCESS_UNAVAILABLE', 'no backend adapter or journal is configured');
      try {
        const result = await applyBackendPlan({
          binding,
          plan: backendPlan,
          sourceSha,
          adapter: resolvedBackendAdapter,
          /**
           * The receipt sink `applyBackendPlan` has always asked for.
           *
           * It writes one receipt per change before making it -- "a crash after
           * this line is interpretable" -- through a method called `flush` that
           * nothing in this repository implemented. Declared in two JSDoc blocks
           * and provided nowhere, so the step that applies a release to the
           * production database failed on `journal.flush is not a function`,
           * having first proved every digest and compatibility check and
           * touched nothing.
           *
           * The run journal is the durable record this run already keeps, and
           * its `append` fsyncs, which is what flushing a receipt before an
           * irreversible write is for.
           */
          journal: {
            flush: async receipt => {
              await journal.append('backend_receipt', receipt);
            }
          }
        });
        return result.ok ? { ok: true } : fail('GATE_FAILED', 'backend apply did not complete');
      } catch (error) {
        return fail(codeOf(error) ?? 'GATE_FAILED', messageOf(error));
      }
    },

    deploy: () => run('deploy', npm('deploy:web'), { cwd, env: childEnv, admission }),

    /**
     * The release is not finished when the upload succeeds; it is finished when
     * the deployed thing works. The first half proves the published artifacts
     * are downloadable, the second asks the live site the questions a person
     * used to ask by hand — and asks them every time, not when someone
     * remembers to.
     */
    live_verify: async () => {
      const published = await run('live_verify', [process.execPath, 'scripts/verify-published-release.mjs'], { cwd, env: childEnv, admission });
      if (!published.ok) return published;
      return run('live_verify', [process.execPath, 'scripts/verify-live-smoke.mjs'], { cwd, env: childEnv, admission });
    }
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
