import type { AnalyticsEventName, AnalyticsProperties, AnalyticsTool } from './events';

export interface ToolJobSnapshot {
  id: string;
  status: string;
}

export interface ToolJobLifecycle {
  started: readonly string[];
  completed: readonly string[];
  failed: readonly string[];
  cancelled: readonly string[];
}

export interface ToolActivityEvent {
  name: AnalyticsEventName;
  properties: AnalyticsProperties;
}

/**
 * A job id the analytics envelope may carry as `run_id` (031 FR-050): the agent mints every
 * queue id with `randomUUID()`. Anything else — an older agent, a test fixture, a value that
 * looks like a file name — is left out rather than sent.
 */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function analyticsRunId(id: string | null | undefined): string | undefined {
  return typeof id === 'string' && RUN_ID.test(id) ? id : undefined;
}

/**
 * Turns queue snapshots into the same small, content-free lifecycle for every local tool.
 *
 * One `operation_started|completed|failed|cancelled` per job, carrying the job id as
 * `run_id` (031 FR-050), so a run's start and its terminal correlate. Names and paths never
 * enter the returned properties, and an id that is not an agent-minted UUID is dropped.
 * Additions are counted in one `input_add_completed`, which carries a `run_id` only when
 * exactly one job was added.
 */
export function toolJobActivityEvents<Job extends ToolJobSnapshot>(
  tool: AnalyticsTool,
  previous: readonly Job[] | null,
  current: readonly Job[],
  lifecycle: ToolJobLifecycle,
  /** 031 FR-052 — the `error_occurred` properties a job that just failed adds, if any. */
  errorFor?: (job: Job, runId: string | undefined) => AnalyticsProperties | null
): ToolActivityEvent[] {
  if (previous === null) return [];

  const before = new Map(previous.map(job => [job.id, job.status]));
  const added = current.filter(job => !before.has(job.id));
  const base = { tool_identifier: tool } as const;
  const events: ToolActivityEvent[] = [];
  const runOf = (job: Job) => {
    const runId = analyticsRunId(job.id);
    return runId ? { run_id: runId } : {};
  };

  if (added.length) {
    events.push({
      name: 'input_add_completed',
      properties: {
        ...base,
        file_count: added.length,
        ...(added.length === 1 ? runOf(added[0]!) : {})
      }
    });
  }

  const started: ToolActivityEvent[] = [];
  const completed: ToolActivityEvent[] = [];
  const failed: ToolActivityEvent[] = [];
  const cancelled: ToolActivityEvent[] = [];
  for (const job of current) {
    const oldStatus = before.get(job.id);
    if (oldStatus === undefined || oldStatus === job.status) continue;
    const run = runOf(job);
    if (lifecycle.started.includes(job.status) && !lifecycle.started.includes(oldStatus)) {
      started.push({ name: 'operation_started', properties: { ...base, file_count: 1, ...run } });
    }
    if (lifecycle.completed.includes(job.status)) {
      completed.push({
        name: 'operation_completed',
        properties: { ...base, file_count: 1, ...run, success: true, outcome: 'success' }
      });
    } else if (lifecycle.failed.includes(job.status)) {
      failed.push({
        name: 'operation_failed',
        properties: { ...base, file_count: 1, ...run, success: false, outcome: 'failure' }
      });
      const error = errorFor?.(job, run.run_id);
      if (error) failed.push({ name: 'error_occurred', properties: error });
    } else if (lifecycle.cancelled.includes(job.status)) {
      cancelled.push({
        name: 'operation_cancelled',
        properties: { ...base, file_count: 1, ...run, outcome: 'cancelled' }
      });
    }
  }
  return [...events, ...started, ...completed, ...failed, ...cancelled];
}
