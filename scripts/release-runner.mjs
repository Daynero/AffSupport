#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readIntent } from './lib/release/intent.mjs';
import { cancelRun, initialRun, resumeRun, transition } from './lib/release/state.mjs';
import { preflight } from './lib/release/preflight.mjs';
import { installedDependencies } from './lib/release/dependencies.mjs';
import { acquireOwnership, registerChild } from './lib/release/ownership.mjs';
import { loadSnapshot, runDirectory, saveSnapshot } from './lib/release/store.mjs';
import { releaseMetrics } from './lib/release/metrics.mjs';
import { STEP_IDS, stepDefinition } from './lib/release/steps.mjs';
import { startSupervisedWorker, waitForWorkerReady } from './lib/release/supervisor.mjs';

/**
 * The whole command surface of the release runner.
 *
 * Six commands, one envelope, and exit codes that mean something a script can
 * branch on: accepted is not completed, waiting is not failure, and cancelled is
 * neither. That distinction is the point. A release on a slow machine spends
 * most of its life waiting — for the machine, for a workflow, for a download —
 * and a caller that cannot tell waiting from broken will either poll a dead run
 * forever or abandon a healthy one.
 */

/**
 * Exit codes from contracts/cli.md.
 *
 * `ACTIVE` covers every state a run can still leave on its own, including
 * resource waits, which are ordinary progress rather than a problem.
 */
const EXIT = Object.freeze({
  ACCEPTED: 0,
  BLOCKED: 1,
  INVALID: 2,
  ACTIVE: 3,
  CANCELLED: 4
});

const ACTIVE_STATES = new Set([
  'draft',
  'preflight',
  'queued',
  'running',
  'waiting_resource',
  'waiting_remote',
  'reconciling',
  'cancelling'
]);

/** @param {{ok: boolean, command: string, runId?: string | null, state?: string | null, data?: unknown, error?: unknown}} value */
export function envelope({ ok, command, runId = null, state = null, data = null, error = null }) {
  return {
    schemaVersion: 1,
    ok,
    command,
    runId,
    state,
    generatedAt: new Date().toISOString(),
    data,
    error
  };
}

export function printEnvelope(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Report tells the caller what happened; its exit code tells a script what to do next. */
export function reportExitCode(state) {
  if (state === 'completed') return EXIT.ACCEPTED;
  if (state === 'cancelled') return EXIT.CANCELLED;
  if (ACTIVE_STATES.has(state)) return EXIT.ACTIVE;
  return EXIT.BLOCKED;
}

/**
 * What `status` puts in `data` beyond the raw snapshot.
 *
 * Read locally, with no network call: the phase the run is in, what it is
 * waiting for and until when, and where the result will be. A status command
 * that had to ask GitHub how a run was doing would be unusable exactly when it
 * matters — offline, rate-limited, or mid-outage.
 */
export function statusProjection(snapshot) {
  const completed = new Set(snapshot.completedSteps ?? []);
  const nextStep = STEP_IDS.find(id => !completed.has(id)) ?? null;
  return {
    phase: snapshot.currentStep ?? nextStep,
    completedSteps: snapshot.completedSteps ?? [],
    remainingSteps: STEP_IDS.filter(id => !completed.has(id)),
    resourceClass: nextStep ? stepDefinition(nextStep).resourceClass : null,
    waiting:
      snapshot.state === 'waiting_resource' || snapshot.state === 'waiting_remote'
        ? {
            reason: snapshot.waitReason ?? snapshot.state,
            nextCheckAt: snapshot.nextCheckAt ?? null
          }
        : null,
    publicationState: snapshot.publicationState ?? 'none',
    resultLocation: path.join(runDirectory(snapshot.runId), 'snapshot.json')
  };
}

/** `--json` is accepted and is also the only output shape; the flag is for callers' scripts. */
function parseArguments(argv) {
  const positional = argv.filter(value => !value.startsWith('--'));
  const flag = name => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
  };
  return { command: positional[0] ?? null, positional: positional.slice(1), flag };
}

async function main(argv) {
  const { command, positional, flag } = parseArguments(argv);
  try {
    if (command === 'status' || command === 'report') {
      const runId = positional[0];
      if (!runId) throw new Error(`Usage: release ${command} <run-id>`);
      const snapshot = await loadSnapshot(runId);
      const projection = statusProjection(snapshot);
      const data =
        command === 'report'
          ? { ...snapshot, ...projection, metrics: releaseMetrics(snapshot.events ?? []) }
          : { ...snapshot, ...projection };
      printEnvelope(envelope({ ok: true, command, runId, state: snapshot.state, data }));
      // Status answers "is this readable"; report answers "is this done".
      process.exitCode = command === 'report' ? reportExitCode(snapshot.state) : EXIT.ACCEPTED;
      return;
    }

    if (command === 'cancel' || command === 'resume') {
      const runId = positional[0];
      if (!runId) throw new Error(`Usage: release ${command} <run-id>`);
      const snapshot = await loadSnapshot(runId);
      const next = command === 'cancel' ? cancelRun(snapshot) : resumeRun(snapshot);
      await saveSnapshot(next);
      printEnvelope(
        envelope({
          ok: true,
          command,
          runId,
          state: next.state,
          data: { ...next, ...statusProjection(next) }
        })
      );
      process.exitCode = command === 'cancel' ? EXIT.CANCELLED : EXIT.ACCEPTED;
      return;
    }

    const intentPath = flag('intent');
    if (!['preflight', 'start'].includes(command) || !intentPath)
      throw new Error('Usage: release <preflight|start> --intent <absolute-json-path> [--json]');
    const intent = await readIntent(intentPath);

    if (command === 'preflight') {
      const bindingsPath = flag('bindings');
      if (!bindingsPath) throw new Error('preflight requires --bindings <absolute-json-path>');
      const bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
      const { probe, bridge } = installedDependencies();
      const result = await preflight(intent, { bindings, probe, bridge });
      printEnvelope(
        envelope({
          ok: result.ok,
          command,
          runId: intent.runId,
          state: result.ok ? 'preflight' : 'blocked',
          // Heavy prerequisites are reported, never performed: preflight reads.
          data: { ...result, scheduledWork: STEP_IDS.filter(id => stepDefinition(id).heavy) },
          error: result.failures[0] ?? null
        })
      );
      process.exitCode = result.ok ? EXIT.ACCEPTED : EXIT.INVALID;
      return;
    }

    const directory = runDirectory(intent.runId);
    const ownership = await acquireOwnership(directory, {
      runId: intent.runId,
      pid: process.pid,
      startedAt: Date.now(),
      bootId: process.env.SOTY_BOOT_ID ?? 'unknown'
    });
    if (!ownership.acquired) {
      printEnvelope(
        envelope({
          ok: false,
          command,
          runId: intent.runId,
          state: 'blocked',
          error: {
            code: 'RELEASE_CONFLICT',
            subject: 'An active run owns this target.',
            resumePredicate: 'owner exits'
          },
          data: ownership.owner
        })
      );
      process.exitCode = EXIT.BLOCKED;
      return;
    }

    const queued = transition(transition(initialRun(intent), 'preflight'), 'queued');
    await saveSnapshot(queued);
    const worker = startSupervisedWorker({
      workerPath: path.resolve('scripts/release-worker.mjs'),
      cwd: process.cwd(),
      env: process.env,
      args: ['--ready-file', path.join(directory, 'worker-ready.json'), intent.runId]
    });
    await registerChild(directory, {
      pid: worker.pid,
      startedAt: Date.now(),
      runId: intent.runId,
      role: 'worker'
    });
    // The worker acknowledges durably before this command returns, so a closed
    // terminal cannot leave a release that nobody is driving.
    const ready = await waitForWorkerReady(path.join(directory, 'worker-ready.json'), intent.runId);
    if (!ownership.release) throw new Error('Ownership release handle is unavailable');
    await ownership.release();
    printEnvelope(
      envelope({
        ok: true,
        command,
        runId: intent.runId,
        state: queued.state,
        data: {
          ...statusProjection(queued),
          accepted: true,
          worker: { pid: worker.pid, acknowledgedAt: ready.acknowledgedAt }
        }
      })
    );
    process.exitCode = EXIT.ACCEPTED;
  } catch (error) {
    printEnvelope(
      envelope({
        ok: false,
        command: command ?? 'release',
        error: {
          code: 'INTENT_INVALID',
          subject: error instanceof Error ? error.message : String(error)
        }
      })
    );
    process.exitCode = EXIT.INVALID;
  }
}

// `process.argv[1]` is absent when this module is imported by an evaluated
// script or a test harness; asking for its URL there would crash on import.
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main(process.argv.slice(2));
}
