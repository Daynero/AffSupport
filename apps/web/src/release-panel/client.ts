import type { ReleasePanelSnapshot } from '../../../../packages/shared/src/release-automation';

export function parseSnapshot(value: unknown): ReleasePanelSnapshot {
  if (!value || typeof value !== 'object') throw new Error('UNSUPPORTED_PANEL_SCHEMA');
  const data = value as Partial<ReleasePanelSnapshot>;
  const states = [
    'accepted',
    'running',
    'waiting',
    'repairing',
    'validating',
    'needs_owner',
    'cancelling',
    'cancelled',
    'completed'
  ];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (
    data.schemaVersion !== 1 ||
    typeof data.taskId !== 'string' ||
    !uuid.test(data.taskId) ||
    typeof data.runId !== 'string' ||
    !uuid.test(data.runId) ||
    !Number.isSafeInteger(data.revision) ||
    (data.revision ?? 0) < 1 ||
    !Number.isSafeInteger(data.generation) ||
    (data.generation ?? 0) < 1 ||
    !data.progress ||
    !Number.isFinite(data.progress.percent) ||
    data.progress.percent < 0 ||
    data.progress.percent > 100 ||
    !Array.isArray(data.progress.steps) ||
    data.progress.steps.length > 100 ||
    data.progress.steps.some(
      step =>
        !step ||
        typeof step.id !== 'string' ||
        typeof step.weight !== 'number' ||
        !Number.isFinite(step.weight) ||
        step.weight <= 0 ||
        !['pending', 'running', 'completed', 'excluded'].includes(step.status)
    ) ||
    typeof data.state !== 'string' ||
    !states.includes(data.state) ||
    typeof data.version !== 'string' ||
    typeof data.targetId !== 'string' ||
    !Array.isArray(data.candidates) ||
    data.candidates.length > 100 ||
    data.candidates.some(candidate => typeof candidate !== 'string' || !uuid.test(candidate)) ||
    typeof data.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.updatedAt)) ||
    !(data.usage === null || (Number.isSafeInteger(data.usage) && (data.usage ?? -1) >= 0)) ||
    !Number.isSafeInteger(data.attempts) ||
    (data.attempts ?? -1) < 0 ||
    !(data.waiting === null || typeof data.waiting === 'string') ||
    !(data.currentStep === null || typeof data.currentStep === 'string') ||
    !(data.workerHeartbeatAt === null || typeof data.workerHeartbeatAt === 'string') ||
    !(
      data.repair === null ||
      (data.repair &&
        typeof data.repair.state === 'string' &&
        typeof data.repair.cause === 'string' &&
        typeof data.repair.executionId === 'string')
    ) ||
    !(
      data.blocker === null ||
      (data.blocker &&
        typeof data.blocker.code === 'string' &&
        typeof data.blocker.requiredAction === 'string' &&
        (data.blocker.detail === null || typeof data.blocker.detail === 'string'))
    )
  )
    throw new Error('UNSUPPORTED_PANEL_SCHEMA');
  return data as ReleasePanelSnapshot;
}
export function newerSnapshot(
  current: ReleasePanelSnapshot | null,
  incoming: ReleasePanelSnapshot
) {
  if (
    !current ||
    current.serverEpoch !== incoming.serverEpoch ||
    incoming.revision > current.revision ||
    (incoming.revision === current.revision &&
      (incoming.serverObservedAt ?? '') > (current.serverObservedAt ?? ''))
  )
    return incoming;
  return current;
}

export async function panelJson(url: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      typeof value === 'object' && value && 'error' in value
        ? String(value.error)
        : 'PANEL_UNAVAILABLE'
    );
  return value;
}
