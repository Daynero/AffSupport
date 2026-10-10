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
/** How long an agent's word about a stopped run stays true without being renewed. */
const AGENT_STATUS_FRESH_MS = 30 * 60_000;

const STEP_NAMES = {
  preflight: 'Передумови',
  prepare: 'Підготовка',
  candidate_gate: 'Перевірка кандидата',
  beta_package: 'Пакування beta',
  beta_verify: 'Перевірка beta',
  backend_beta: 'Репетиція backend',
  readiness: 'Готовність до публікації',
  macos_package: 'Пакування macOS',
  windows_smoke: 'Windows: перевірка',
  publish: 'Публікація артефактів',
  manifest: 'Підписаний маніфест',
  manifest_beta_verify: 'Перевірка commit маніфесту',
  backend_apply: 'Оновлення backend',
  deploy: 'Розгортання web',
  live_verify: 'Фінальна жива перевірка'
};

/** @param {{ type: string }[]} events @param {string} type */
function lastIndexOf(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1)
    if (events[index].type === type) return index;
  return -1;
}

/** The useful line of a failure: the runner's subject carries whole command lines and logs. */
function failureLine(error) {
  const subject = String(error?.subject ?? '');
  const url = /https:\/\/github\.com\/\S+\/actions\/runs\/\d+/.exec(subject)?.[0];
  const head = subject
    .split(/\s+—\s+/)
    .slice(-1)[0]
    .split('\n')[0]
    .trim();
  return url ? `Збірка в GitHub Actions не пройшла: ${url}` : head.slice(0, 300) || null;
}

/**
 * Where a run stands, in the panel's states — and who is on it.
 *
 * The runner itself stops at a failed step and waits. In this flow the agent
 * running the release is the one who fixes and resumes it; while it says so
 * (a fresh `agent-status.json` beside the run), the panel shows that work, not
 * a request aimed at a person.
 */
/**
 * @param {{ state?: string, error?: { code?: string } }} run
 * @param {{ type: string, payload?: any }[]} events
 * @param {{ message?: string, updatedAt?: string } | null} [agent]
 * @param {number} [now]
 */
export function panelState(run, events, agent = null, now = Date.now()) {
  const lastFailed = lastIndexOf(events, 'step_failed');
  const lastStarted = lastIndexOf(events, 'step_started');
  const failed = lastFailed > lastStarted ? events[lastFailed].payload : null;
  if (run.state === 'completed') return { state: 'completed', blocker: null, reason: null };
  if (run.state === 'cancelled') return { state: 'cancelled', blocker: null, reason: null };
  if (run.state === 'cancelling') return { state: 'cancelling', blocker: null, reason: null };
  const fresh =
    agent &&
    typeof agent.message === 'string' &&
    now - Date.parse(agent.updatedAt ?? '') < AGENT_STATUS_FRESH_MS;
  if (run.state === 'blocked' || failed) {
    if (fresh) return { state: 'repairing', blocker: null, reason: agent.message };
    const step = STEP_NAMES[failed?.stepId] ?? failed?.stepId ?? 'Етап';
    return {
      state: 'needs_owner',
      reason: null,
      blocker: {
        code: `«${step}» не пройшов`,
        detail: failureLine(failed?.error),
        requiredAction: 'Чекає агента, який виправить причину й перезапустить етап.'
      }
    };
  }
  if (run.state === 'reconciling') return { state: 'validating', blocker: null, reason: null };
  if (run.state === 'waiting_resource') return { state: 'waiting', blocker: null, reason: null };
  return { state: 'running', blocker: null, reason: null };
}

export function watchSnapshot(taskId, plan, observed, revisionBase = 0) {
  const { run, events, heartbeat, windowsUrl, agent } = observed;
  const runId = run.runId ?? taskId;
  const { state, blocker, reason } = panelState(run, events, agent ?? null);
  return {
    schemaVersion: 1,
    taskId,
    // At least 1: a run that has not written its first event yet is still revision one.
    revision: revisionBase + Math.max(1, events.length),
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
    progressReason: reason,
    repair: null,
    usage: null,
    attempts: 0,
    blocker,
    windowsUrl,
    nativePercent: null,
    readOnly: true
  };
}

/** The run the release is on now: the agent points here when it starts a fresh run. */
const CURRENT = () => path.join(runnerRoot(), 'current-release.json');

async function currentRunId(fallback) {
  try {
    const value = JSON.parse(await readFile(CURRENT(), 'utf8'));
    return validTaskId(value.runId);
  } catch {
    return fallback;
  }
}

async function agentStatus(runId) {
  try {
    return JSON.parse(await readFile(path.join(runDirectory(runId), 'agent-status.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function main(argv) {
  // The task id is the link's identity and never changes; the run under it may, when a fix
  // needs a new source commit and so a new run. One link follows the whole release.
  const taskId = validTaskId(argv[0]);
  const runner = createControllerRunner({ root: runnerRoot(), repositoryRoot, bindingsPath: '' });
  let runId = await currentRunId(taskId);
  let plan = freezeProgress(await history(runId));
  let revisionBase = 0;
  const watcher = new EventEmitter();
  let last = null;
  const read = async () => {
    const next = await currentRunId(runId);
    if (next !== runId) {
      runId = next;
      plan = freezeProgress(await history(runId));
      // A new run starts its journal from one; the panel only takes newer revisions.
      revisionBase += 1_000_000;
    }
    const observed = await runner.observe(runId);
    return watchSnapshot(
      taskId,
      plan,
      { ...observed, agent: await agentStatus(runId) },
      revisionBase
    );
  };
  // The panel server asks a controller for these; a watcher answers the reads and refuses the rest.
  Object.assign(watcher, {
    snapshot: () => read(),
    store: {
      read: async id => {
        if (id !== taskId) throw new Error('TASK_NOT_FOUND');
        return { taskId, runId };
      },
      list: async () => [{ taskId, runId }]
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
      const mark = `${snapshot.revision}:${snapshot.state}:${snapshot.workerHeartbeatAt}:${snapshot.currentStep}:${snapshot.progressReason}`;
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
  console.log(panel.bootstrapUrl(taskId));
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
