import { isRecord } from './contract.js';

export interface LaunchAssignmentState {
  launchId: string;
  version: string;
  state: 'unassigned' | 'assigned' | 'released' | 'legacy_unknown';
  agentRowId: string | null;
  sourceAgentRowId: string | null;
}
export interface LaunchAssignmentReceipt extends LaunchAssignmentState {
  operationId: string;
  requestKey: string;
}
export function parseLaunchAssignmentState(value: unknown): LaunchAssignmentState | null {
  if (
    !isRecord(value) ||
    typeof value.launchId !== 'string' ||
    !value.launchId ||
    typeof value.version !== 'string' ||
    !/^\d{1,19}$/u.test(value.version) ||
    !['unassigned', 'assigned', 'released', 'legacy_unknown'].includes(String(value.state)) ||
    !(
      value.agentRowId === null ||
      (typeof value.agentRowId === 'string' && value.agentRowId.length > 0)
    ) ||
    !(
      value.sourceAgentRowId === null ||
      (typeof value.sourceAgentRowId === 'string' && value.sourceAgentRowId.length > 0)
    ) ||
    (value.state === 'assigned' && value.agentRowId === null) ||
    ((value.state === 'unassigned' || value.state === 'released') && value.agentRowId !== null)
  )
    return null;
  return {
    launchId: value.launchId,
    version: value.version,
    state: value.state as LaunchAssignmentState['state'],
    agentRowId: value.agentRowId as string | null,
    sourceAgentRowId: value.sourceAgentRowId as string | null
  };
}
export function parseLaunchAssignmentReceipt(value: unknown): LaunchAssignmentReceipt | null {
  const state = parseLaunchAssignmentState(value);
  if (
    !state ||
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !value.operationId ||
    typeof value.requestKey !== 'string' ||
    !value.requestKey
  )
    return null;
  return { ...state, operationId: value.operationId, requestKey: value.requestKey };
}
