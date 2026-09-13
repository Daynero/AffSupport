#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createJournal, recoverJournal } from './lib/release/journal.mjs';
import { recoverState } from './lib/release/recovery.mjs';
import { executeReleaseFlow } from './lib/release/flow.mjs';
import { completeStep, startStep, transition } from './lib/release/state.mjs';
import { stepDefinition } from './lib/release/steps.mjs';
import { startLeaseServer } from './lib/release/lease-server.mjs';
import { boundedDiagnostic, diagnosticFingerprint } from './lib/release/diagnostics.mjs';
import { enqueueHandoff } from './lib/release/handoff.mjs';
import { loadSnapshot, runDirectory, saveSnapshot } from './lib/release/store.mjs';
import { activeBinding } from './lib/release/bindings.mjs';
import { createWorkerAdmission, installedProbeFrom } from './lib/release/worker-admission.mjs';
import {
  adoptWorktree,
  createOwnedWorktree,
  provisionWorktree
} from './lib/release/adapters/git-worktree.mjs';

/**
 * The process that actually performs a release.
 *
 * `release-runner start` only accepts work and hands it here; this is where the
 * pieces become one thing. It owns the admission socket for the whole machine,
 * writes the journal entry before each effect rather than after, keeps the
 * snapshot in step with the journal so a later run can tell what really
 * happened, and turns a failure into one bounded, redacted, deduplicated
 * handoff instead of a wall of log.
 *
 * It is deliberately supervised and detached: the release must survive the
 * terminal that started it closing. Nothing here calls a model.
 */

/** Only the outer run holds the host-wide slot; nested children inherit it. */
const CAPABILITY_BYTES = 32;

export async function writeReady(readyFile, runId) {
  await mkdir(path.dirname(readyFile), { recursive: true, mode: 0o700 });
  const temporary = `${readyFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(workerReady(runId)), { mode: 0o600 });
  await rename(temporary, readyFile);
}

export function workerReady(runId) {
  return { runId, ready: true, acknowledgedAt: new Date().toISOString() };
}

/**
 * A cancellation is a decision, not a note to be written over.
 *
 * `cancel` marks the run and returns; the worker keeps going, finishes whatever
 * it was doing, and saves its own state on top -- so a cancelled release
 * reported itself as blocked a second later, enqueued a repair job nobody
 * asked for, and carried on holding the machine until somebody sent it a
 * signal by hand. Twice, tonight.
 *
 * Every write the worker makes goes through here, and every write first reads
 * what is on disk. A run somebody cancelled stays cancelled, and the worker
 * learns about it at the next thing it tries to record.
 *
 * @returns {Promise<{cancelled: boolean, run: object}>}
 */
async function persist(run) {
  const persisted = await loadSnapshot(run.runId).catch(() => null);
  if (persisted?.state === 'cancelled') return { cancelled: true, run: persisted };
  await saveSnapshot(run);
  return { cancelled: false, run };
}

/**
 * Runs one step: journal first, then the effect, then the journal again.
 *
 * The order is the whole recovery story. An entry written before the effect
 * means a crash leaves "this was about to happen", which a later run can go and
 * check. An entry written only afterwards would leave the one state nobody can
 * interpret — an effect that may or may not exist, with nothing saying it was
 * ever attempted.
 */
async function performStep({ stepId, run, journal, adapter, snapshot }) {
  const step = stepDefinition(stepId);
  // Asked before the effect, because "it was already running" is not a reason
  // to start the next one.
  if ((await loadSnapshot(run.runId).catch(() => null))?.state === 'cancelled')
    return { ok: false, error: { code: 'RELEASE_CANCELLED', subject: 'the run was cancelled' } };
  await journal.append('step_started', { stepId, resourceClass: step.resourceClass });
  const started = Date.now();
  let result;
  try {
    result = await adapter.execute(stepId, run);
  } catch (error) {
    result = { ok: false, error: { code: 'GATE_FAILED', subject: messageOf(error) } };
  }
  await journal.append(result?.ok ? 'step_completed' : 'step_failed', {
    stepId,
    durationMs: Date.now() - started,
    error: result?.ok ? null : (result?.error ?? { code: 'GATE_FAILED' })
  });
  if (result?.ok) {
    const advanced = completeStep(startStep(snapshot.current, stepId), stepId);
    const stored = await persist(advanced);
    snapshot.current = stored.run;
    if (stored.cancelled)
      return { ok: false, error: { code: 'RELEASE_CANCELLED', subject: 'the run was cancelled' } };
    await journal.snapshot(advanced);
  }
  return result;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Packages a failure for unattended repair.
 *
 * The fingerprint is the failure, not the attempt, so the same broken thing
 * failing twice produces one job. The diagnostic is bounded and redacted before
 * it is written, because this record is the thing that leaves the machine.
 */
async function handOffFailure({ directory, runId, sourceSha, failedStep, error, journal }) {
  const fingerprint = diagnosticFingerprint({
    stepId: failedStep ?? 'unknown',
    inputDigest: sourceSha,
    error: error?.subject ?? error?.code ?? 'unknown'
  });
  const diagnostic = boundedDiagnostic({
    ok: false,
    lines: [error?.subject ?? ''].filter(Boolean),
    error: error?.code ?? 'GATE_FAILED',
    evidenceRefs: [journal.journalPath],
    resumePredicate: `release resume ${runId}`
  });
  const job = await enqueueHandoff(path.join(directory, 'handoff'), {
    jobId: `${runId}:${fingerprint.slice(0, 16)}`,
    fingerprint,
    runId,
    payload: diagnostic
  });
  await journal.append('handoff_enqueued', { jobId: job.jobId, fingerprint });
  return job;
}

/**
 * @param {{
 *   runId: string,
 *   adapter: {execute: (stepId: string, run: unknown) => Promise<{ok: boolean, error?: unknown}>},
 *   backendPlan?: {changes: readonly unknown[]} | null,
 *   admission?: {withAdmission: (stepId: string, run: () => Promise<any>) => Promise<any>, setWaitReporter?: (reporter: (event: any) => Promise<void>) => void} | null,
 *   directory?: string
 * }} options
 */
export async function runWorker({
  runId,
  adapter,
  backendPlan = null,
  admission = null,
  directory = runDirectory(runId)
}) {
  const journal = await createJournal(directory, runId);
  // Anything the previous worker left behind is reconciled before this one
  // takes over; a torn final write is quarantined rather than trusted.
  const { events, quarantined } = await recoverJournal(journal.journalPath, runId);
  if (quarantined) await journal.append('journal_quarantined', { quarantined });

  const loaded = await loadSnapshot(runId);
  const recovered = recoverState(loaded, events);
  const snapshot = { current: recovered };
  if (recovered !== loaded) await saveSnapshot(recovered);

  const capability = randomBytes(CAPABILITY_BYTES).toString('hex');
  const lease = await startLeaseServer({
    socketPath: path.join(directory, 'admit.sock'),
    capability,
    generation: recovered.generation ?? 1,
    children: new Map()
  });
  await journal.append('worker_started', { pid: process.pid, socketPath: lease.socketPath });

  // Waiting for the machine is ordinary progress, so it belongs in the journal
  // and in the snapshot `status` reads — not in a log nobody is watching.
  admission?.setWaitReporter?.(async event => {
    await journal.append('resource_wait', event);
    const waiting = {
      ...snapshot.current,
      waitReason: event.reason,
      nextCheckAt: new Date(event.nextCheckAt).toISOString()
    };
    snapshot.current = (await persist(waiting)).run;
  });

  try {
    const result = await executeReleaseFlow({
      run: { runId, sourceSha: recovered.sourceSha, targetKind: recovered.targetKind ?? 'sandbox' },
      backendPlan,
      admission,
      completed: recovered.completedSteps ?? [],
      adapter: {
        execute: (stepId, run) => performStep({ stepId, run, journal, adapter, snapshot })
      },
      async onStep(event) {
        // A backend step nobody declared still advances the run: it is a step
        // with no work, not a step left undone, and the journal says which.
        if (event.phase !== 'not_declared') return;
        await journal.append('step_not_declared', { stepId: event.stepId });
        const advanced = completeStep(startStep(snapshot.current, event.stepId), event.stepId);
        snapshot.current = (await persist(advanced)).run;
        await journal.snapshot(advanced);
      }
    });
    if (!result.ok) {
      const blocked = transition(
        snapshot.current.state === 'running'
          ? snapshot.current
          : { ...snapshot.current, state: 'running' },
        'blocked'
      );
      const stored = await persist(blocked);
      snapshot.current = stored.run;
      // Nobody is asked to repair a release somebody stopped on purpose.
      if (stored.cancelled) return { ok: false, state: 'cancelled', failedStep: result.failedStep };
      await journal.snapshot(blocked);
      await handOffFailure({
        directory,
        runId,
        sourceSha: recovered.sourceSha,
        failedStep: result.failedStep,
        error: result.error,
        journal
      });
      return { ok: false, state: blocked.state, failedStep: result.failedStep };
    }
    await journal.append('run_completed', { completed: result.completed });
    await journal.snapshot(snapshot.current);
    return { ok: true, state: snapshot.current.state, completed: result.completed };
  } finally {
    // The socket is this worker's, and it does not outlive it: a stale socket
    // would let the next run's children believe they had been admitted.
    await lease.close();
  }
}

// `process.argv[1]` is absent when this module is imported by an evaluated
// script or a test harness; asking for its URL there would crash on import.
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [flag, readyFile, runId] = process.argv.slice(2);
  if (flag !== '--ready-file' || !path.isAbsolute(readyFile) || !runId) {
    process.stderr.write(
      'release-worker is supervised by release-runner; direct execution is disabled.\n'
    );
    process.exitCode = 2;
  } else {
    // Acknowledge durably first. The runner is waiting on this file, and a
    // release that cannot prove it was accepted must not start doing work.
    await writeReady(readyFile, runId);
    const snapshot = await loadSnapshot(runId);
    const backendPlan = process.env.SOTY_RELEASE_BACKEND_PLAN
      ? JSON.parse(await readFile(process.env.SOTY_RELEASE_BACKEND_PLAN, 'utf8'))
      : null;
    // The real executor by default. An installation may point at its own module
    // instead, which is how a sandbox rehearsal substitutes safe destinations
    // without this file knowing anything about them.
    const { createStepAdapter } = process.env.SOTY_RELEASE_STEP_ADAPTER
      ? await import(pathToFileURL(process.env.SOTY_RELEASE_STEP_ADAPTER).href)
      : await import('./lib/release/step-adapter.mjs');
    let adapter;
    let worktree = null;
    try {
      const identity = {
        runId,
        version: snapshot.version ?? process.env.SOTY_RELEASE_VERSION,
        sourceSha: snapshot.sourceSha,
        binding: activeBinding(),
        backendPlan,
        allowRemote: process.env.SOTY_RELEASE_DRY_RUN !== '1'
      };
      // Identity first, and deliberately before anything exists: a run with no
      // version has no release to perform, and a checkout made for it would be a
      // directory nobody asked for and nobody removes.
      adapter = await createStepAdapter(identity);
      /**
       * Every step runs against the commit this release names, not against
       * whatever the checkout happens to hold.
       *
       * The module for this was written and tested and never called, so the
       * runner declared a `sourceSha` and then built the working tree. On a
       * repository where somebody is working in parallel — which is the case
       * this whole feature exists for — that ships their unfinished work under a
       * version verified without it. It came within one step of doing exactly
       * that.
       *
       * The worker keeps its own directory: the journal, the snapshot and the
       * run state stay where `status` can find them. Only the steps move.
       */
      // A run that failed kept its checkout on purpose; a resume takes it back
      // rather than rebuilding everything the first attempt already produced.
      const record = path.join(runDirectory(runId), 'worktree.json');
      worktree =
        (await adoptWorktree({
          cwd: process.cwd(),
          sourceSha: snapshot.sourceSha,
          directory: await readFile(record, 'utf8')
            .then(text => JSON.parse(text).directory)
            .catch(() => null)
        })) ?? (await createOwnedWorktree({ cwd: process.cwd(), sourceSha: snapshot.sourceSha }));
      await writeFile(
        record,
        `${JSON.stringify({ directory: worktree.directory, sourceSha: worktree.sourceSha }, null, 2)}\n`,
        { mode: 0o600 }
      );
      const provisioning = await provisionWorktree({
        cwd: process.cwd(),
        directory: worktree.directory
      });
      process.stdout.write(
        `release-worker ${'adopted' in worktree ? 'resuming in' : 'building in'} ${worktree.directory} ` +
          `at ${worktree.sourceSha.slice(0, 12)} ` +
          `(provisioned: ${provisioning.provisioned.join(', ') || 'nothing'})\n`
      );
      adapter = await createStepAdapter({ ...identity, cwd: worktree.directory });
    } catch (error) {
      // A run whose frozen identity or destination cannot be resolved has
      // nothing it may legitimately do. Saying so is the honest outcome;
      // exiting zero would look exactly like a release that had run.
      process.stderr.write(`release-worker cannot act on this run: ${messageOf(error)}\n`);
      process.exitCode = 2;
      adapter = null;
    }
    if (adapter) {
      const profile = JSON.parse(
        await readFile(new URL('../config/release-resource-profiles.json', import.meta.url), 'utf8')
      ).default;
      const admission = await createWorkerAdmission({
        runId,
        profile,
        probe: await installedProbeFrom(),
        onWait: () => {}
      });
      try {
        const result = await runWorker({ runId, backendPlan, adapter, admission });
        process.exitCode = result.ok ? 0 : 1;
      } finally {
        admission.stop();
        // Left in place when the run did not finish: a resumed release wants the
        // same checkout, and a worktree is cheap next to a rebuild.
        if (worktree && process.exitCode === 0) await worktree.remove().catch(() => {});
      }
    }
  }
}
