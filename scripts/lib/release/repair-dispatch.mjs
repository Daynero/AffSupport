import { randomUUID, createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CodexProvider, normalizeUsage, allowReadCommand, providerBoundaryDigest } from './codex-provider.mjs';
import { createRepairCheckout, applyRepairCandidate } from './repair-source.mjs';
import { atomicRecord } from './task-store.mjs';
import { reserveAttempt, recordUsage, budgetReason } from './repair-budget.mjs';
import { createWorkerAdmission, installedProbeFrom } from './worker-admission.mjs';
import { listHandoffs, markSubmitting, recordAttempt, recordResult } from './handoff.mjs';
import { runDirectory } from './store.mjs';

const resultSchema = { type: 'object', additionalProperties: false,
  properties: { executionId: { type: 'string' }, outcome: { type: 'string', enum: ['repaired', 'cannot_repair', 'needs_owner'] }, notes: { type: 'string', maxLength: 4000 } },
  required: ['executionId', 'outcome', 'notes'] };

export function createRepairExecutor({ root, repositoryRoot, executable, capabilityPath, policy, bindingsPath, runner }) {
  const advance = async (task, checkout, callbacks) => {
    const isCurrent = async () => { const current = await callbacks.current(); return current.generation === task.generation && !['cancelling', 'cancelled', 'completed'].includes(current.state); };
    const profile = JSON.parse(await readFile(new URL('../../../config/release-resource-profiles.json', import.meta.url), 'utf8')).default;
    const bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
    const admission = await createWorkerAdmission({ runId: task.runId, profile, probe: await installedProbeFrom() });
    let candidate;
    try { candidate = await admission.withAdmission('publish', () => applyRepairCandidate({ checkout, repositoryRoot, intent: task.intent, binding: bindings[task.intent.targetId], taskId: task.taskId, isCurrent })); }
    finally { admission.stop(); }
    if (!await isCurrent()) return;
    const intent = { ...task.intent, runId: randomUUID(), sourceSha: candidate.sourceSha, createdAt: new Date().toISOString() };
    await runner.validate(intent);
    await callbacks.update({ state: 'running', runId: intent.runId, intent, candidates: [...task.candidates, intent.runId],
      generation: task.generation + 1, plan: (await import('./progress.mjs')).freezeProgress(), repair: null, retryAt: null,
      progressReason: 'Зміна source SHA анулювала попередні докази: новий кандидат повторює канонічні перевірки.' });
    if ((await callbacks.current()).runId === intent.runId && (await callbacks.current()).state === 'running') await runner.start(intent);
  };
  const execute = async (task, observed, callbacks) => {
    const failed = [...observed.events].reverse().find((e) => e.type === 'step_failed');
    const cause = `${failed?.payload.stepId ?? 'unknown'}:${failed?.payload.error?.code ?? 'GATE_FAILED'}`;
    await callbacks.update({ lastCause: cause });
    if (observed.events.some((e) => e.type === 'step_started' && ['publish', 'manifest', 'backend_apply', 'deploy'].includes(e.payload.stepId))) throw new Error('PUBLISHED_INPUT_REPAIR_REQUIRES_OWNER');
    const receipt = JSON.parse(await readFile(capabilityPath, 'utf8'));
    if (!receipt.ready || receipt.checks?.untrustedPolicy !== true || receipt.version !== policy.providerVersion || receipt.executable !== executable || receipt.boundaryDigest !== await providerBoundaryDigest()) throw new Error('PROVIDER_CAPABILITY_REQUIRED');
    const jobs = await listHandoffs(path.join(runDirectory(task.runId), 'handoff'));
    const job = jobs.find((j) => j.state === 'delivery_pending');
    if (!job) throw new Error('REPAIR_JOB_NOT_AVAILABLE');
    const executionId = randomUUID();
    const health = new CodexProvider({ executable, checkout: repositoryRoot, deniedPaths: [repositoryRoot], expectedVersion: policy.providerVersion });
    try { await health.health(); } finally { health.close(); }
    const recordFile = path.join(root, 'executions', `${executionId}.json`);
    const reason = budgetReason(task.budget, cause, policy);
    if (reason) throw new Error(reason);
    const jobKey = createHash('sha256').update(`${job.jobId}:${task.budget.attempts.length}`).digest('hex');
    const claimFile = path.join(root, 'job-claims', `${jobKey}.json`);
    await atomicRecord(recordFile, { taskId: task.taskId, jobId: job.jobId, executionId, generation: task.generation, state: 'claimed' }, true);
    const profile = JSON.parse(await readFile(new URL('../../../config/release-resource-profiles.json', import.meta.url), 'utf8')).default;
    const admission = await createWorkerAdmission({ runId: task.runId, profile, probe: await installedProbeFrom(),
      onWait: async (event) => { await callbacks.update({ state: 'waiting', repair: { state: 'waiting_resource', cause, executionId, reason: event.reason } }); } });
    let checkout;
    try { checkout = await admission.withAdmission('publish', () => createRepairCheckout({ root, repositoryRoot, sourceSha: task.intent.sourceSha, executionId })); }
    finally { admission.stop(); }
    const isCurrent = async () => { const current = await callbacks.current(); return current.generation === task.generation && !['cancelling', 'cancelled', 'completed'].includes(current.state); };
    let threadId = null; let turnId = null;
    const provider = new CodexProvider({ executable, checkout, expectedVersion: policy.providerVersion, deniedPaths: [repositoryRoot], allowRead: async (params) =>
      params.threadId === threadId && (!turnId || params.turnId === turnId) && await isCurrent() && await allowReadCommand(params, checkout), allowPatch: async (params) => {
      if (params.threadId !== threadId || (turnId && params.turnId !== turnId)) throw new Error('REPAIR_EXECUTION_MISMATCH');
      return await isCurrent() && (params.grantRoot == null || params.grantRoot === checkout);
    } });
    let budget = task.budget;
    /** @type {{result: {executionId: string, outcome: string, notes: string} | null}} */
    const answer = { result: null }; let finish; let failedTurn;
    const done = new Promise((resolve, reject) => { finish = resolve; failedTurn = reject; });
    done.catch(() => {});
    let writes = Promise.resolve();
    let deadline = null;
    let cancelTimer = null;
    let claimed = false; let executionStarted = false;
    const persist = (patch) => { writes = writes.then(() => callbacks.update(patch)); return writes; };
    provider.on('notification', (event) => {
      if (event.params?.threadId !== threadId) return;
      if (event.method === 'turn/started') {
        turnId = event.params.turn.id;
        isCurrent().then(current => { if (!current) return provider.interrupt(threadId, turnId); }).catch(failedTurn);
      }
      if (event.method === 'thread/tokenUsage/updated') {
        budget = recordUsage(budget, executionId, normalizeUsage(event.params.tokenUsage), Date.now(), policy.maxTokensPerAttempt);
        persist({ budget }).catch(failedTurn);
        if ((budget.totalTokens ?? 0) >= policy.maxTokensPerTask || budget.attempts.at(-1)?.usage?.totalTokens >= policy.maxTokensPerAttempt) provider.interrupt(threadId, turnId).catch(failedTurn);
      }
      if (event.method === 'item/completed' && event.params.item.type === 'agentMessage') {
        try { answer.result = JSON.parse(event.params.item.text); } catch { /* final parser remains authoritative */ }
      }
      if (event.method === 'turn/completed') finish(event.params.turn);
    });
    provider.on('unavailable', (code) => failedTurn(new Error(code)));
    try {
      await provider.health();
      if (!await isCurrent()) return;
      const config = (await provider.request('config/read', { includeLayers: false })).config ?? {};
      if (config.model_provider && config.model_provider !== 'openai') throw new Error('MANAGED_PROVIDER_REQUIRED');
      const overrides = { 'features.hooks': false, web_search: 'disabled' };
      for (const name of Object.keys(config.mcp_servers ?? {})) overrides[`mcp_servers.${name}.enabled`] = false;
      const thread = await provider.request('thread/start', { cwd: checkout, ephemeral: false, approvalPolicy: 'untrusted', modelProvider: 'openai',
        allowProviderModelFallback: false, config: overrides,
        baseInstructions: 'You repair source using /bin/cat filename (one bounded file per call) and apply_patch. Only these reads and patches are approved. Do not run compound commands, tests, builds, installs, scripts, agents, network or production actions: canonical gates run independently. Read only files needed for the diagnostic. Never change version, keys, credentials or release artifacts. Return the required structured result.', });
      if (thread.activePermissionProfile?.id !== 'soty_repair' || thread.modelProvider !== 'openai') throw new Error('REPAIR_PERMISSION_PROFILE_MISMATCH');
      threadId = thread.thread.id;
      await atomicRecord(claimFile, { taskId: task.taskId, jobId: job.jobId, executionId, generation: task.generation }, true).catch(() => { throw new Error('REPAIR_JOB_OWNERSHIP_AMBIGUOUS'); });
      claimed = true;
      budget = reserveAttempt(budget, cause, policy, executionId);
      await atomicRecord(recordFile, { taskId: task.taskId, jobId: job.jobId, executionId, generation: task.generation, threadId, state: 'starting', checkout });
      await callbacks.update({ state: 'repairing', budget, repair: { executionId, cause, state: 'starting', threadId, turnId: null, checkout } });
      if (!await isCurrent()) return;
      executionStarted = true; // From here a lost turn acknowledgement is ambiguous, never retried blindly.
      const submitting = await markSubmitting(path.join(runDirectory(task.runId), 'handoff'), job);
      await recordAttempt(path.join(runDirectory(task.runId), 'handoff'), submitting, { state: 'acknowledged' });
      const diagnostic = JSON.stringify({ error: job.payload?.error, lines: job.payload?.lines ?? [], previousAttempt: task.lastRepairNotes ?? null }).slice(0, 16384);
      const started = await provider.request('turn/start', { threadId, clientUserMessageId: executionId,
        input: [{ type: 'text', text: `Execution ${executionId}. Repair the source causing ${cause}. Diagnostic: ${diagnostic}. Return executionId=${executionId}. Do not claim gate success.` }], outputSchema: resultSchema });
      turnId = started.turn.id;
      await atomicRecord(recordFile, { taskId: task.taskId, jobId: job.jobId, executionId, generation: task.generation, threadId, turnId, state: 'running', checkout });
      await persist({ repair: { executionId, cause, state: 'running', threadId, turnId, checkout } });
      deadline = setTimeout(() => { provider.interrupt(threadId, turnId).catch(() => {}); failedTurn(new Error('REPAIR_TIME_BUDGET_EXHAUSTED')); }, policy.maxActiveMsPerAttempt);
      cancelTimer = setInterval(() => { isCurrent().then((current) => { if (!current) { provider.interrupt(threadId, turnId).catch(() => {}); failedTurn(new Error('REPAIR_GENERATION_STALE')); } }).catch(failedTurn); }, 2000);
      const completed = await done;
      const result = answer.result;
      await writes;
      const attempt = budget.attempts.at(-1); attempt.finished = true; attempt.activeMs = Date.now() - attempt.startedAt;
      await persist({ budget });
      if (attempt.usage?.totalTokens == null) throw new Error('REPAIR_USAGE_UNKNOWN');
      if (!await isCurrent()) return;
      if (completed.status !== 'completed' || !result || result.executionId !== executionId || !['repaired', 'cannot_repair', 'needs_owner'].includes(result.outcome) || typeof result.notes !== 'string' || result.notes.length > 4000) throw new Error('REPAIR_RESULT_INVALID');
      await atomicRecord(recordFile, { taskId: task.taskId, jobId: job.jobId, executionId, generation: task.generation, threadId, turnId, state: 'completed', checkout, result });
      await recordResult(path.join(runDirectory(task.runId), 'handoff'), job.fingerprint, { status: result.outcome === 'repaired' ? 'repaired' : result.outcome });
      if (result.outcome === 'needs_owner') throw Object.assign(new Error('REPAIR_NEEDS_OWNER'), { detail: result.notes });
      if (result.outcome === 'cannot_repair') {
        const exhausted = budgetReason(budget, cause, policy);
        if (exhausted) throw new Error(exhausted);
        const records = await listHandoffs(path.join(runDirectory(task.runId), 'handoff'));
        await recordAttempt(path.join(runDirectory(task.runId), 'handoff'), records.find((record) => record.jobId === job.jobId), { state: 'delivery_pending', submitted: false });
        await callbacks.update({ state: 'waiting', repair: null, retryAt: new Date(Date.now() + 30000).toISOString(), lastRepairNotes: result.notes });
        return;
      }
      await callbacks.update({ state: 'validating', repair: { executionId, cause, state: 'validating', threadId, turnId, checkout } });
      provider.close(); // tools cannot race diff validation/import
      await advance(task, checkout, callbacks);
    } finally {
      if (deadline) clearTimeout(deadline); if (cancelTimer) clearInterval(cancelTimer);
      provider.close();
      await done.catch(() => {});
      if (claimed && !executionStarted) await unlink(claimFile); // No model execution was submitted.
    }
  };
  execute.recover = async (task, callbacks) => {
    const executionId = task.repair.executionId;
    const record = JSON.parse(await readFile(path.join(root, 'executions', `${executionId}.json`), 'utf8'));
    if (record.taskId !== task.taskId || record.generation !== task.generation || record.executionId !== executionId) throw new Error('REPAIR_EXECUTION_MISMATCH');
    const attempt = task.budget.attempts.find((entry) => entry.executionId === executionId);
    if (record.state === 'completed' && record.result?.outcome === 'repaired' && attempt?.finished && attempt.usage?.totalTokens != null) {
      await advance(task, record.checkout, callbacks); return;
    }
    // Read persisted provider state without starting/resuming a model turn.
    // Missing final usage or ambiguous acceptance remains an explicit blocker.
    if (record.threadId) {
      const provider = new CodexProvider({ executable, checkout: record.checkout, expectedVersion: policy.providerVersion, deniedPaths: [repositoryRoot] });
      try {
        await provider.health();
        const response = await provider.request('thread/read', { threadId: record.threadId, includeTurns: true });
        const turn = response.thread?.turns?.find((entry) => entry.id === record.turnId);
        if (turn?.status === 'completed' && !attempt?.finished) throw new Error('REPAIR_USAGE_UNKNOWN');
      } finally { provider.close(); }
    }
    throw new Error('AGENT_EXECUTION_AMBIGUOUS');
  };
  return execute;
}
