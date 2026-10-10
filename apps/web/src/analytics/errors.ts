import { ERROR_STAGES_BY_TOOL, type AnalyticsProperties, type AnalyticsTool } from './events';
import { analytics, type ProductAnalytics } from './service';

/**
 * 031 FR-052 — `error_occurred` for every tool, in one shape.
 *
 * `error_stage` comes from the tool's closed vocabulary in `ERROR_STAGES_BY_TOOL`, `error_code`
 * is a stable machine code (the agent's, or one of the client's own checks), and the
 * fingerprint is `<tool>:<stage>:<code>`. Nothing here ever reads a message: an exception's
 * text can carry a local path, a file name or a token, so anything that is not already a code
 * becomes `unknown`.
 */

export type ErrorTool = Exclude<keyof typeof ERROR_STAGES_BY_TOOL, 'readiness' | 'link'>;
export type ToolErrorStage<T extends ErrorTool> = (typeof ERROR_STAGES_BY_TOOL)[T][number];

/** The agent's and the client's own codes: `CONNECTION_FAILED`, `MEDIA_TOOL_UNAVAILABLE`. */
const MACHINE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const UNKNOWN_ERROR_CODE = 'unknown';

/**
 * The code an error carries, or `unknown`. Accepts an `Error` (its message is the code by the
 * client's convention), an object with a `code`, or a bare string; free text never passes.
 */
export function safeErrorCode(value: unknown, fallback: string = UNKNOWN_ERROR_CODE): string {
  const candidates: unknown[] = [];
  if (value && typeof value === 'object' && 'code' in value) {
    candidates.push((value as { code?: unknown }).code);
  }
  if (value instanceof Error) candidates.push(value.message);
  else if (typeof value === 'string') candidates.push(value);
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && MACHINE_CODE.test(candidate)) return candidate;
  }
  return fallback;
}

export function errorFingerprint(tool: ErrorTool, stage: string, code: string): string {
  return `${tool}:${stage}:${code}`;
}

/** Which part of the team workspace a `team_operations.kind` belongs to. */
export function teamOperationErrorStage(kind: string): ToolErrorStage<'team'> {
  if (kind === 'process') return 'process';
  if (kind === 'download') return 'download';
  if (kind === 'upload' || kind === 'new_version' || kind === 'content_edit') return 'transfer';
  return 'library';
}

export interface ToolErrorInput<T extends ErrorTool> {
  tool: T;
  stage: ToolErrorStage<T>;
  /** Already a code, or anything `safeErrorCode` can read one from. */
  code: unknown;
  runId?: string;
  flowId?: string;
  workflowId?: string;
  attemptId?: string;
  retryable?: boolean;
}

/** The properties of one `error_occurred`, for callers that collect events before tracking. */
export function toolErrorProperties<T extends ErrorTool>(
  input: ToolErrorInput<T>
): AnalyticsProperties {
  const code = safeErrorCode(input.code);
  return {
    // `team` is not a standalone tool; its events are told apart by the fingerprint.
    ...(input.tool === 'team' ? {} : { tool_identifier: input.tool as AnalyticsTool }),
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(input.flowId ? { flow_id: input.flowId } : {}),
    ...(input.workflowId ? { workflow_id: input.workflowId } : {}),
    ...(input.attemptId ? { attempt_id: input.attemptId } : {}),
    error_stage: input.stage,
    error_code: code,
    error_fingerprint: errorFingerprint(input.tool, input.stage, code),
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    outcome: 'failure'
  };
}

export function trackToolError<T extends ErrorTool>(
  input: ToolErrorInput<T>,
  tracker: Pick<ProductAnalytics, 'track'> = analytics
): void {
  tracker.track('error_occurred', toolErrorProperties(input));
}
