import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProcess } from './agent-process.js';
import type { Scenario, Step, ToolId } from './interleaving-scenarios.js';
import { sampleMachine, type MachineSample } from './machine-probe.js';
import { waitFor } from './wait.js';

/**
 * Walks a scenario against a real local app, checking the machine after every step.
 *
 * The whole point is the *disagreement*: what the tool reports and what the operating system
 * is doing, compared at every checkpoint rather than at the end. A leak that appears at step
 * seven and is tidied away by step nineteen is still twelve steps of a machine the user was
 * told was idle, and only a per-step comparison can name where it began.
 *
 * A step the harness cannot perform is reported, never skipped quietly. "Twenty-eight steps
 * ran" and "twenty-three ran and five were silently dropped" are different results, and a
 * runner that cannot tell them apart is not measuring what it claims to.
 */

export interface StepOutcome {
  index: number;
  step: Step;
  /** False when the harness has no way to perform this step; `reason` says why. */
  applied: boolean;
  reason?: string;
}

export interface ScenarioResult {
  scenario: Scenario;
  outcomes: StepOutcome[];
  /** Steps the harness could not perform, for the caller to assert against a named list. */
  unperformed: StepOutcome[];
}

/** The agent's own name for a job, once it has one. */
type JobIds = Map<string, string>;

/**
 * Soty's share of the machine, above which the tree is not idle.
 *
 * The same two percent SC-002 uses. It is a share of the whole machine computed over the
 * tree the harness itself spawned, so someone else's build cannot push it up — only work
 * this application is actually doing.
 */
const IDLE_SHARE_PERCENT = 2;

/** How long consumption is allowed to take to come down once nothing is reported running. */
const SETTLE_MS = 10_000;

interface ToolAdapter {
  /** Adds a fixture and returns the agent's id for it. */
  add(agent: AgentProcess, fixture: string, root: string): Promise<string>;
  start(agent: AgentProcess, id: string): Promise<void>;
  stop(agent: AgentProcess, id: string): Promise<void>;
  stopAll(agent: AgentProcess): Promise<void>;
  /** The status this tool reports for one job, or null when it no longer has it. */
  status(agent: AgentProcess, id: string): Promise<string | null>;
  /** Whether the tool reports any work in progress. */
  busy(agent: AgentProcess): Promise<boolean>;
}

interface QueueLike {
  jobs?: { id: string; status: string }[];
  running?: boolean;
}

async function fixtureFile(root: string, fixture: string): Promise<string> {
  const target = path.join(root, fixture.replace(/\/$/, ''));
  await writeFile(target, 'fixture');
  return target;
}

const COMPRESSOR: ToolAdapter = {
  async add(agent, fixture, root) {
    const file = await fixtureFile(root, fixture);
    await agent.api('/api/files/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [file] })
    });
    const state = await agent.api<QueueLike>('/api/queue');
    const added = state.jobs?.at(-1);
    if (!added) throw new Error(`the compressor did not accept ${fixture}`);
    return added.id;
  },
  async start(agent, id) {
    await agent.request('/api/queue/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });
  },
  async stop(agent, id) {
    await agent.request(`/api/jobs/${id}/cancel`, { method: 'POST' });
  },
  async stopAll(agent) {
    await agent.request('/api/queue/cancel-all', { method: 'POST' });
  },
  async status(agent, id) {
    const state = await agent.api<QueueLike>('/api/queue');
    return state.jobs?.find(job => job.id === id)?.status ?? null;
  },
  async busy(agent) {
    return Boolean((await agent.api<QueueLike>('/api/queue')).running);
  }
};

const TRANSCRIPTION: ToolAdapter = {
  async add(agent, fixture, root) {
    const file = await fixtureFile(root, fixture);
    await agent.api('/api/transcription/files/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [file] })
    });
    const state = await agent.api<QueueLike>('/api/transcription/state');
    const added = state.jobs?.at(-1);
    if (!added) throw new Error(`transcription did not accept ${fixture}`);
    return added.id;
  },
  async start(agent, id) {
    await agent.request('/api/transcription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });
  },
  async stop(agent, id) {
    await agent.request(`/api/transcription/jobs/${id}/cancel`, { method: 'POST' });
  },
  async stopAll(agent) {
    await agent.request('/api/transcription/cancel-all', { method: 'POST' });
  },
  async status(agent, id) {
    const state = await agent.api<QueueLike>('/api/transcription/state');
    return state.jobs?.find(job => job.id === id)?.status ?? null;
  },
  async busy(agent) {
    return Boolean((await agent.api<QueueLike>('/api/transcription/state')).running);
  }
};

const ADAPTERS: Partial<Record<ToolId, ToolAdapter>> = {
  compressor: COMPRESSOR,
  transcription: TRANSCRIPTION
};

/**
 * The tools this runner can drive over HTTP.
 *
 * Exported so a test can assert that everything a scenario names *and* this runner supports
 * was actually driven. Without that, a broken adapter turns into a scenario that quietly
 * performed nothing and disagreed with nothing.
 */
export const DRIVABLE_TOOLS: readonly ToolId[] = Object.keys(ADAPTERS) as ToolId[];

/** Every tool that reports itself busy right now. */
async function anyToolBusy(agent: AgentProcess): Promise<boolean> {
  for (const adapter of Object.values(ADAPTERS)) if (await adapter.busy(agent)) return true;
  return false;
}

/**
 * Compares what the tools say with what the machine is doing.
 *
 * Only one direction is an error: reporting idle while the machine is working. The reverse —
 * reporting busy a moment before the child is spawned — is a job that has been accepted and
 * is about to run, which is the truth.
 */
async function checkpoint(
  agent: AgentProcess,
  previous: MachineSample
): Promise<{ sample: MachineSample; disagreement: string | null }> {
  let sample = await sampleMachine(agent.pid, previous);
  if (await anyToolBusy(agent)) return { sample, disagreement: null };

  let quiet = sample.sotySharePercent <= IDLE_SHARE_PERCENT;
  if (!quiet) {
    await waitFor(
      async () => {
        sample = await sampleMachine(agent.pid, sample);
        quiet = sample.sotySharePercent <= IDLE_SHARE_PERCENT;
        return quiet;
      },
      { timeoutMs: SETTLE_MS, intervalMs: 250, describe: 'consumption to reach idle' }
    ).catch(() => {});
  }

  return {
    sample,
    disagreement: quiet
      ? null
      : `every tool reports idle while Soty is using ${sample.sotySharePercent.toFixed(1)}% ` +
        `of ${sample.totalCapacityCores} cores`
  };
}

export async function runScenario(
  scenario: Scenario,
  agent: AgentProcess,
  root: string
): Promise<ScenarioResult> {
  const ids: JobIds = new Map();
  const outcomes: StepOutcome[] = [];
  let sample = await sampleMachine(agent.pid);

  for (const [index, step] of scenario.steps.entries()) {
    const outcome = await perform(step, index, agent, root, ids);
    outcomes.push(outcome);

    if (!scenario.checkpointEvery) continue;
    const checked = await checkpoint(agent, sample);
    sample = checked.sample;
    if (checked.disagreement) {
      throw new Error(
        `step ${index} (${describe(step)}) of "${scenario.intent}": ${checked.disagreement}`
      );
    }
  }

  return { scenario, outcomes, unperformed: outcomes.filter(outcome => !outcome.applied) };
}

function describe(step: Step): string {
  return 'tool' in step ? `${step.do} ${step.tool}` : step.do;
}

async function perform(
  step: Step,
  index: number,
  agent: AgentProcess,
  root: string,
  ids: JobIds
): Promise<StepOutcome> {
  const skipped = (reason: string): StepOutcome => ({ index, step, applied: false, reason });

  if (step.do === 'restartAgent') {
    await agent.crash();
    await agent.restart();
    return { index, step, applied: true };
  }
  if (step.do === 'sleepWake') {
    // No route asks the machine to suspend, and faking one would test the fake. The step
    // stays in the sequence because the checkpoint around it is still worth taking.
    return skipped('the harness cannot suspend the machine from inside a test');
  }
  if (step.do === 'setLimit') {
    await agent.request('/api/power/limit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ percent: step.percent })
    });
    return { index, step, applied: true };
  }

  const adapter = ADAPTERS[step.tool];
  if (!adapter) return skipped(`no HTTP adapter for ${step.tool}`);

  if (step.do === 'add') {
    ids.set(step.jobRef, await adapter.add(agent, step.fixture, root));
    return { index, step, applied: true };
  }

  // Before the identifier lookup: stopping everything names no job.
  if (step.do === 'stopAll') {
    await adapter.stopAll(agent);
    return { index, step, applied: true };
  }

  const id = ids.get(step.jobRef);
  if (!id) return skipped(`${step.jobRef} was never added`);

  if (step.do === 'start' || step.do === 'rerun') await adapter.start(agent, id);
  else if (step.do === 'stop') await adapter.stop(agent, id);
  else if (step.do === 'expect') {
    // Waited for rather than sampled: a status is reached asynchronously, and reading it the
    // instant the previous step returned would fail on scheduling rather than on behaviour.
    await waitFor(async () => (await adapter.status(agent, id)) === step.status, {
      timeoutMs: 20_000,
      intervalMs: 100,
      describe: `${step.tool} ${step.jobRef} to report ${step.status}`
    });
  }
  return { index, step, applied: true };
}
