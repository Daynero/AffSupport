import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolveIntent } from './intent.mjs';
import { claimTarget, processIdentity } from './target-ownership.mjs';
import { freezeProgress, projectProgress } from './progress.mjs';
import { budgetReason } from './repair-budget.mjs';
import { redactText } from './redaction.mjs';

const terminal = new Set(['completed', 'cancelled']);
function requiredAction(code) {
  if (/BUDGET/.test(code)) return 'Ліміт ремонту вичерпано. Потрібна явна зміна policy; лічильники не скидаються.';
  if (/AMBIGUOUS|USAGE_UNKNOWN/.test(code)) return 'Звірити збережені worker/thread/turn/result/usage. Не запускати іншого редактора навмання.';
  if (/CAPABILITY|VERSION_MISMATCH/.test(code)) return 'Повторити ізольований provider smoke для встановленої версії та поточного коду дозволів.';
  if (/SCOPE|FROZEN_VERSION|PUBLISHED_INPUT/.test(code)) return 'Потрібне окремо дозволене виправлення або новий релізний intent; наявні версію, теги й assets не змінювати.';
  if (/ACTIVATION|ACCEPTANCE|RATIFICATION/.test(code)) return 'Потрібні справжні G0 та sandbox-докази. Dry-run або unit-тести їх не замінюють.';
  if (/AUTH|PROVIDER|ACCESS/.test(code)) return 'Відновити managed-auth/доступ/квоту провайдера та виконати doctor; платний API fallback заборонений.';
  return 'Перевірити конкретну помилку й збережений журнал; retry можливий лише після валідованого рішення власника.';
}
/** One deterministic owner. Models are called only inside injected repair(), never tick(). */
export class ReleaseController extends EventEmitter {
  constructor({ root, store, runner, repair, policy, identity = processIdentity, inspect = processIdentity }) {
    super(); this.root = root; this.store = store; this.runner = runner;
    this.repair = repair; this.policy = policy; this.identity = identity; this.inspect = inspect;
    this.claims = new Map(); this.active = new Map(); this.observations = new Map(); this.queues = new Map(); this.liveTasks = new Set(); this.accepting = false;
  }
  async mutate(id, transform) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const current = await this.store.read(id);
      const patch = transform(current);
      if (!patch) return current;
      const task = await this.store.update(id, current.revision, patch);
      this.emit('snapshot', await this.snapshot(task)); return task;
    });
    this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  async accept(raw) {
    if (this.accepting || this.liveTasks.size) throw new Error('AUTOMATION_TASK_ALREADY_ACTIVE');
    this.accepting = true;
    try { return await this.acceptTask(raw); } finally { this.accepting = false; }
  }
  async acceptTask(raw) {
    const intent = resolveIntent(raw);
    if (!('version' in intent)) throw new Error('FROZEN_RELEASE_VERSION_REQUIRED');
    const taskId = randomUUID();
    const claim = await claimTarget(this.root, intent.targetId, taskId, await this.identity(), this.inspect);
    if (!claim.acquired) throw new Error('RELEASE_TARGET_CONFLICT');
    this.claims.set(taskId, claim);
    try {
      await this.runner.validate(intent);
      const task = await this.store.create({ taskId, intent, runId: intent.runId, candidates: [intent.runId],
        state: 'accepted', generation: 1, plan: freezeProgress(), budget: { attempts: [], totalTokens: null }, blocker: null, repair: null });
      this.liveTasks.add(taskId);
      try { await this.runner.start(intent); }
      catch (error) { return this.block(taskId, error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'RUNNER_START_FAILED'); }
      return this.mutate(task.taskId, () => ({ state: 'running' }));
    } catch (error) {
      await claim.release(); this.claims.delete(taskId); throw error;
    }
  }
  async snapshot(task) {
    const cached = this.observations.get(task.taskId);
    const observed = cached?.run?.runId === task.runId ? cached : undefined;
    const run = observed?.run ?? { state: 'queued', currentStep: null };
    const progress = projectProgress(task.plan, run, observed?.events ?? []);
    return { schemaVersion: 1, taskId: task.taskId, revision: task.revision, generation: task.generation,
      version: task.intent.version, targetId: task.intent.targetId, state: task.state,
      runId: task.runId, candidates: task.candidates, progress, currentStep: run.currentStep,
      updatedAt: task.updatedAt, workerHeartbeatAt: observed?.heartbeat?.observedAt ?? null,
      waiting: run.waitReason ?? null, repair: task.repair ? { state: task.repair.state, cause: task.repair.cause, executionId: task.repair.executionId } : null,
      nextCheckAt: task.retryAt ?? run.nextCheckAt ?? null, progressReason: task.progressReason ?? null,
      usage: task.budget.totalTokens, attempts: task.budget.attempts.length, blocker: task.blocker,
      windowsUrl: observed?.windowsUrl ?? null, nativePercent: null };
  }
  /** @param {string} id @param {string} code @param {string | null} detail */
  async block(id, code, detail = null) {
    return this.mutate(id, (task) => terminal.has(task.state) || task.state === 'cancelling' ? null :
      task.blocker?.code === code ? null : { state: 'needs_owner', blocker: { code, detail: detail ? redactText(detail).slice(0, 4000) : null, requiredAction: requiredAction(code) } });
  }
  async tick(id) {
    const task = await this.store.read(id);
    if (terminal.has(task.state)) return;
    const observed = await this.runner.observe(task.runId);
    this.observations.set(id, observed);
    this.emit('observation', await this.snapshot(task));
    if (task.state === 'needs_owner') return;
    if (task.retryAt && Date.now() < Date.parse(task.retryAt)) return;
    const progress = projectProgress(task.plan, observed.run, observed.events);
    if (progress.final) {
      await this.mutate(id, (current) => current.state === 'cancelling' ? null : { state: 'completed', blocker: null, completedAt: new Date().toISOString() });
      await this.claims.get(id)?.release(); this.claims.delete(id); this.liveTasks.delete(id); return;
    }
    if (task.state === 'cancelling' || observed.run.state === 'cancelled') {
      await this.runner.cancel(task.runId);
      if (await this.runner.stopped(task.runId)) {
        await this.mutate(id, () => ({ state: 'cancelled' }));
        await this.claims.get(id)?.release(); this.claims.delete(id); this.liveTasks.delete(id);
      }
      return;
    }
    if (this.active.has(id)) return;
    if (observed.run.state === 'blocked') {
      if (!await this.runner.stopped(task.runId)) return;
      const generation = task.generation;
      const work = this.repair(task, observed, {
        update: (patch) => this.mutate(id, (current) => current.generation === generation && !terminal.has(current.state) && current.state !== 'cancelling' ? patch : null),
        current: () => this.store.read(id),
      }).catch(async (error) => {
        const code = error instanceof Error ? error.message : 'REPAIR_FAILED';
        const current = await this.store.read(id);
        if (/^PROVIDER_(?:UNAVAILABLE|EXITED|RPC_TIMEOUT)$/.test(code) && ['starting', 'running'].includes(current.repair?.state)) {
          await this.block(id, 'AGENT_EXECUTION_AMBIGUOUS'); return;
        }
        if (/^PROVIDER_(?:UNAVAILABLE|EXITED|RPC_TIMEOUT)$/.test(code) && !['starting', 'running'].includes(current.repair?.state)) {
          const since = current.deliverySince ?? Date.now();
          if (Date.now() - since < 30 * 60000) {
            const failures = (current.deliveryFailures ?? 0) + 1;
            await this.mutate(id, (latest) => latest.generation !== generation || latest.state === 'cancelling' || terminal.has(latest.state) ? null :
              { state: 'waiting', repair: null, deliverySince: since, deliveryFailures: failures,
                retryAt: new Date(Date.now() + Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4))).toISOString() });
            return;
          }
        }
        await this.block(id, code, error instanceof Error && 'detail' in error && typeof error.detail === 'string' ? error.detail : null);
      });
      this.active.set(id, work);
      work.finally(() => this.active.delete(id)).catch(() => {});
      return;
    }
    if (await this.runner.stopped(task.runId)) {
      await this.runner.start(task.intent); // runner reconciles, never resets or repeats effects
    }
    const state = /^waiting/.test(observed.run.state) ? 'waiting' : 'running';
    if (task.state !== state) await this.mutate(id, () => ({ state }));
  }
  async recover() {
    for (const task of await this.store.list()) {
      if (terminal.has(task.state)) continue;
      this.liveTasks.add(task.taskId);
      const claim = await claimTarget(this.root, task.intent.targetId, task.taskId, await this.identity(), this.inspect);
      if (!claim.acquired) throw new Error('RELEASE_TARGET_CONFLICT');
      this.claims.set(task.taskId, claim);
      if (task.repair && ['starting', 'running', 'validating'].includes(task.repair.state)) {
        if (this.repair.recover) {
          const generation = task.generation;
          await this.repair.recover(task, {
            current: () => this.store.read(task.taskId),
            update: (patch) => this.mutate(task.taskId, (current) => current.generation === generation && !terminal.has(current.state) && current.state !== 'cancelling' ? patch : null),
          }).catch((error) => this.block(task.taskId, error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'AGENT_EXECUTION_AMBIGUOUS'));
          continue;
        }
        // A lost acknowledgement may represent a still-running turn. Never duplicate it.
        await this.block(task.taskId, 'AGENT_EXECUTION_AMBIGUOUS', 'Preserved thread/turn identifiers require provider reconciliation.');
      } else await this.tick(task.taskId);
    }
  }
  async cancel(id, revision) {
    const task = await this.store.read(id);
    if (revision !== task.revision) throw new Error('TASK_REVISION_CONFLICT');
    await this.mutate(id, (current) => {
      if (revision !== current.revision) throw new Error('TASK_REVISION_CONFLICT');
      return terminal.has(current.state) ? null : { state: 'cancelling', generation: current.generation + 1 };
    });
    await this.runner.cancel(task.runId);
    return this.store.read(id);
  }
  async decide(id, revision, decision) {
    const task = await this.store.read(id);
    if (task.revision !== revision) throw new Error('TASK_REVISION_CONFLICT');
    if (task.state !== 'needs_owner' || decision !== 'retry') throw new Error('INVALID_OWNER_DECISION');
    if (/AMBIGUOUS|USAGE_UNKNOWN/.test(task.blocker.code) ||
        (/BUDGET/.test(task.blocker.code) && budgetReason(task.budget, task.lastCause ?? task.repair?.cause ?? 'unknown', this.policy))) throw new Error('OWNER_DECISION_REQUIRES_NEW_POLICY_OR_RECONCILIATION');
    await this.runner.validate(task.intent);
    return this.mutate(id, (current) => {
      if (current.revision !== revision) throw new Error('TASK_REVISION_CONFLICT');
      return { state: 'running', blocker: null, retryAt: null };
    });
  }
}
