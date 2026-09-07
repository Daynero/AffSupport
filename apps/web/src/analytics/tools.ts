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
 * Turns queue snapshots into the same small, content-free lifecycle for every local tool.
 * Names, paths and job ids deliberately never enter the returned properties.
 */
export function toolJobActivityEvents(
  tool: AnalyticsTool,
  previous: readonly ToolJobSnapshot[] | null,
  current: readonly ToolJobSnapshot[],
  lifecycle: ToolJobLifecycle
): ToolActivityEvent[] {
  if (previous === null) return [];

  const before = new Map(previous.map(job => [job.id, job.status]));
  const added = current.filter(job => !before.has(job.id)).length;
  const counts = { started: 0, completed: 0, failed: 0, cancelled: 0 };

  for (const job of current) {
    const oldStatus = before.get(job.id);
    if (oldStatus === undefined || oldStatus === job.status) continue;
    if (lifecycle.started.includes(job.status) && !lifecycle.started.includes(oldStatus)) {
      counts.started += 1;
    }
    if (lifecycle.completed.includes(job.status)) counts.completed += 1;
    else if (lifecycle.failed.includes(job.status)) counts.failed += 1;
    else if (lifecycle.cancelled.includes(job.status)) counts.cancelled += 1;
  }

  const base = { tool_identifier: tool } as const;
  const events: ToolActivityEvent[] = [];
  if (added)
    events.push({ name: 'input_add_completed', properties: { ...base, file_count: added } });
  if (counts.started)
    events.push({ name: 'operation_started', properties: { ...base, file_count: counts.started } });
  if (counts.completed)
    events.push({
      name: 'operation_completed',
      properties: { ...base, file_count: counts.completed, success: true, outcome: 'success' }
    });
  if (counts.failed)
    events.push({
      name: 'operation_failed',
      properties: { ...base, file_count: counts.failed, success: false, outcome: 'failure' }
    });
  if (counts.cancelled)
    events.push({
      name: 'operation_cancelled',
      properties: { ...base, file_count: counts.cancelled, outcome: 'cancelled' }
    });
  return events;
}
