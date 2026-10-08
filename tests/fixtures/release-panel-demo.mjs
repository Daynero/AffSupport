/** Synthetic browser fixture: no canonical runner, provider or external actions. */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setInterval, clearInterval } from 'node:timers';
import { startPanelServer } from '../../scripts/lib/release/panel-server.mjs';
import { freezeProgress, projectProgress } from '../../scripts/lib/release/progress.mjs';
const taskId = randomUUID();
const runId = randomUUID();
const task = { taskId, runId, revision: 1 };
const plan = freezeProgress();
const events = plan
  .slice(0, 8)
  .map(step => ({ type: 'step_completed', payload: { stepId: step.id } }));
const controller = Object.assign(new EventEmitter(), {
  store: { read: async () => task, list: async () => [task] },
  snapshot: async () => ({
    schemaVersion: 1,
    taskId,
    runId,
    revision: task.revision,
    generation: 1,
    version: 'DEMO — 1.2.5',
    targetId: 'demo-only-no-release',
    state: 'waiting',
    candidates: [runId],
    progress: projectProgress(
      plan,
      { state: 'waiting_remote', currentStep: 'windows_smoke' },
      events
    ),
    currentStep: 'windows_smoke',
    updatedAt: new Date().toISOString(),
    workerHeartbeatAt: new Date().toISOString(),
    waiting: 'Демонстрація: очікування Windows CI, жоден реліз не запущено',
    repair: null,
    usage: null,
    attempts: 0,
    blocker: null,
    windowsUrl: null
  }),
  cancel: async () => {
    throw new Error('DEMO_HAS_NO_RELEASE_TO_CANCEL');
  }
});
const panel = await startPanelServer({
  controller,
  assetsRoot: path.resolve('release/automation/panel'),
  port: 0
});
console.log(panel.bootstrapUrl(taskId));
const heartbeat = setInterval(
  async () => controller.emit('observation', await controller.snapshot()),
  2000
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    clearInterval(heartbeat);
    void panel.close().then(() => process.exit(0));
  });
