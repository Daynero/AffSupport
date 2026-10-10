#!/usr/bin/env node
/**
 * The progress panel for a run of the canonical runner, read-only.
 *
 * The controller (feature 029) shows this panel for the tasks it owns, and it
 * only accepts a production task with G0 and three live sandbox records. A
 * release started with `npm run release -- start` still deserves a progress
 * widget, and watching needs none of that: this reads the run's hash-chained
 * journal, snapshot and worker heartbeat — what the controller's observer
 * reads — and serves them on the same loopback panel. It starts nothing,
 * repairs nothing, invokes no model and cannot cancel; stopping a run stays
 * `npm run release -- cancel <runId>`.
 *
 *   node scripts/release-panel-watch.mjs <runId>
 */
import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startPanelServer } from './lib/release/panel-server.mjs';
import { createControllerRunner } from './lib/release/controller-runner.mjs';
import { freezeProgress, projectProgress } from './lib/release/progress.mjs';
import { runDirectory, runnerRoot } from './lib/release/store.mjs';
import { validTaskId } from './lib/release/task-store.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Step durations of earlier runs, so the weights say how long each gate really takes. */
async function history(exceptRunId) {
  const events = [];
  const entries = await readdir(runnerRoot(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === exceptRunId) continue;
    const text = await readFile(
      path.join(runnerRoot(), entry.name, 'journal.ndjson'),
      'utf8'
    ).catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.includes('"step_completed"')) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* a torn last line of another run says nothing about this one */
      }
    }
  }
  return events;
}

/** The runner's own words for where a run stands, in the panel's states. */
export function panelState(run, events) {
  const lastFailed = events.findLastIndex(e => e.type === 'step_failed');
  const lastStarted = events.findLastIndex(e => e.type === 'step_started');
  const failure = lastFailed > lastStarted ? events[lastFailed].payload?.error : null;
  if (run.state === 'completed') return { state: 'completed', blocker: null };
  if (run.state === 'cancelled') return { state: 'cancelled', blocker: null };
  if (run.state === 'cancelling') return { state: 'cancelling', blocker: null };
  if (run.state === 'blocked' || failure) {
    const code = failure?.code ?? run.error?.code ?? 'RUN_BLOCKED';
    return {
      state: 'needs_owner',
      blocker: {
        code,
        detail: failure?.subject ?? null,
        requiredAction: 'Fix the cause, then run `npm run release -- start` with the same intent.'
      }
    };
  }
  if (run.state === 'reconciling') return { state: 'validating', blocker: null };
  if (run.state === 'waiting_resource') return { state: 'waiting', blocker: null };
  return { state: 'running', blocker: null };
}

export function watchSnapshot(runId, plan, observed) {
  const { run, events, heartbeat, windowsUrl } = observed;
  const { state, blocker } = panelState(run, events);
  return {
    schemaVersion: 1,
    taskId: runId,
    // At least 1: a run that has not written its first event yet is still revision one.
    revision: Math.max(1, events.length),
    generation: run.generation ?? 1,
    version: run.version ?? '',
    targetId: run.targetId ?? '',
    state,
    runId,
    // Candidates are run ids; the canonical runner keeps one run per source SHA.
    candidates: [runId],
    progress: projectProgress(plan, run, events),
    currentStep: run.currentStep ?? null,
    updatedAt: run.updatedAt ?? new Date().toISOString(),
    workerHeartbeatAt: heartbeat?.observedAt ?? null,
    // The runner leaves its last wait in the snapshot; it is news only while the run waits.
    waiting: state === 'waiting' ? (run.waitReason ?? null) : null,
    nextCheckAt: state === 'waiting' ? (run.nextCheckAt ?? null) : null,
    progressReason: null,
    repair: null,
    usage: null,
    attempts: 0,
    blocker,
    windowsUrl,
    nativePercent: null,
    readOnly: true
  };
}

async function main(argv) {
  const runId = validTaskId(argv[0]);
  const runner = createControllerRunner({ root: runnerRoot(), repositoryRoot, bindingsPath: '' });
  const plan = freezeProgress(await history(runId));
  const watcher = new EventEmitter();
  let last = null;
  const read = async () => watchSnapshot(runId, plan, await runner.observe(runId));
  // The panel server asks a controller for these; a watcher answers the reads and refuses the rest.
  Object.assign(watcher, {
    snapshot: () => read(),
    store: {
      read: async id => {
        if (id !== runId) throw new Error('TASK_NOT_FOUND');
        return { taskId: runId, runId };
      },
      list: async () => [{ taskId: runId, runId }]
    },
    cancel: async () => {
      throw new Error('PANEL_READ_ONLY');
    }
  });
  await readFile(path.join(runDirectory(runId), 'snapshot.json')).catch(() => {
    throw new Error('RUN_NOT_FOUND');
  });
  const panel = await startPanelServer({
    controller: watcher,
    assetsRoot: path.join(runnerRoot(), 'panel')
  });
  const tick = async () => {
    try {
      const snapshot = await read();
      const mark = `${snapshot.revision}:${snapshot.state}:${snapshot.workerHeartbeatAt}:${snapshot.currentStep}`;
      if (mark !== last) {
        last = mark;
        watcher.emit('snapshot', snapshot);
      }
    } catch {
      /* the next tick reads again; a torn write is not a failed release */
    }
  };
  const timer = setInterval(() => void tick(), 2000);
  await tick();
  console.log(panel.bootstrapUrl(runId));
  console.error('Read-only. The link works once, for 60 seconds; run this again for a new one.');
  const stop = async () => {
    clearInterval(timer);
    await panel.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'WATCH_FAILED'
      })
    );
    process.exitCode = 1;
  });
}
