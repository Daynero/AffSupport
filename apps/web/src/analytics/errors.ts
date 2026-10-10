import {
  LANDING_ERROR_CODES,
  STITCH_ERROR_CODES,
  knownErrorCode,
  type LandingJob,
  type StitchJob,
  type TranscriptionJob
} from '@video-compressor/shared';
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

/* ---------------------------------------------------------------------------
 * 033 FR-007 — the agent's own code for each tool's failed job, never a reading
 * of the sentence beside it. Each code maps to a stage of its tool; a code the
 * map does not name failed in the tool's main step. An agent older than the
 * field gives `unknown`.
 * ------------------------------------------------------------------------- */

const TRANSCRIPTION_CODE_STAGES: Readonly<Record<string, ToolErrorStage<'transcription'>>> = {
  MODEL_MISSING: 'model',
  AUDIO_EXTRACT_FAILED: 'input',
  DOCUMENT_WRITE_FAILED: 'save',
  DOCUMENT_UNAVAILABLE: 'save',
  TRANSLATION_FAILED: 'translate',
  TRANSLATOR_UNAVAILABLE: 'translate'
};

/** Which part of a transcription a code belongs to; anything unnamed failed while transcribing. */
export function transcriptionErrorStage(code: string): ToolErrorStage<'transcription'> {
  return TRANSCRIPTION_CODE_STAGES[code] ?? 'transcribe';
}

export function transcriptionErrorCode(
  job: Pick<TranscriptionJob, 'errorCode' | 'status'>
): string {
  // `interrupted` is a status, so even an agent older than the field names it.
  return safeErrorCode(job.errorCode ?? (job.status === 'interrupted' ? 'INTERRUPTED' : null));
}

/** `error_occurred` for a transcription that just failed, correlated by its `run_id`. */
export function transcriptionFailureError(
  job: Pick<TranscriptionJob, 'errorCode' | 'status'>,
  runId?: string
): AnalyticsProperties {
  const code = transcriptionErrorCode(job);
  return toolErrorProperties({
    tool: 'transcription',
    stage: transcriptionErrorStage(code),
    code,
    ...(runId ? { runId } : {})
  });
}

/**
 * `error_occurred` for each translation that just failed or found no engine. A translation's
 * status already carries a closed code; a cancellation is not a failure.
 */
export function transcriptionTranslationErrors(
  previous: readonly Pick<TranscriptionJob, 'id' | 'translation'>[] | null,
  current: readonly Pick<TranscriptionJob, 'id' | 'translation'>[],
  runIdOf: (id: string) => string | undefined = () => undefined
): AnalyticsProperties[] {
  if (previous === null) return [];
  const before = new Map(previous.map(job => [job.id, job.translation?.status]));
  const errors: AnalyticsProperties[] = [];
  for (const job of current) {
    const translation = job.translation;
    if (!translation || (translation.status !== 'failed' && translation.status !== 'unavailable'))
      continue;
    if (!before.has(job.id) || before.get(job.id) === translation.status) continue;
    if (translation.error === 'TRANSLATION_CANCELLED') continue;
    const runId = runIdOf(job.id);
    errors.push(
      toolErrorProperties({
        tool: 'transcription',
        stage: 'translate',
        code: translation.error,
        ...(runId ? { runId } : {})
      })
    );
  }
  return errors;
}

const STITCH_CODE_STAGES: Readonly<Record<string, ToolErrorStage<'stitcher'>>> = {
  STITCH_PATH_INVALID: 'input_probe',
  STITCH_PLAN_VIDEO_CODEC: 'input_probe',
  STITCH_PLAN_AUDIO_CODEC: 'input_probe',
  STITCH_PLAN_VARIABLE_FRAME_RATE: 'input_probe',
  STITCH_PLAN_CONTAINER: 'input_probe',
  STITCH_PLAN_UNREADABLE: 'input_probe',
  STITCH_PLAN_NOTHING_TO_REMOVE: 'input_probe',
  STITCH_PLAN_NO_SCREENS: 'input_probe',
  STITCH_OUTPUT_UNWRITABLE: 'output',
  STITCH_VERIFICATION_FAILED: 'output'
};

/** Which part of a stitch a code belongs to; anything unnamed failed while stitching. */
export function stitchErrorStage(code: string): ToolErrorStage<'stitcher'> {
  return STITCH_CODE_STAGES[code] ?? 'stitch';
}

export function stitchErrorCode(job: Pick<StitchJob, 'errorCode' | 'error'>): string {
  // An agent older than the field already put a code in `error`; only one from the closed
  // list is taken, so nothing outside it is ever sent.
  return safeErrorCode(
    job.errorCode ?? knownErrorCode(STITCH_ERROR_CODES, job.error?.replace(/-/g, '_'))
  );
}

/** `error_occurred` for a stitch that just failed, correlated by its `run_id`. */
export function stitchFailureError(
  job: Pick<StitchJob, 'errorCode' | 'error'>,
  runId?: string
): AnalyticsProperties {
  const code = stitchErrorCode(job);
  return toolErrorProperties({
    tool: 'stitcher',
    stage: stitchErrorStage(code),
    code,
    ...(runId ? { runId } : {})
  });
}

const LANDING_CODE_STAGES: Readonly<Record<string, ToolErrorStage<'landing-optimizer'>>> = {
  LANDING_WORKSPACE_LOST: 'upload',
  DISK_FULL: 'package',
  DESTINATION_NOT_WRITABLE: 'package',
  LANDING_REWRITE_FAILED: 'package',
  LANDING_PACKAGE_FAILED: 'package'
};

/** Which part of a landing run a code belongs to; anything unnamed failed while optimizing. */
export function landingErrorStage(code: string): ToolErrorStage<'landing-optimizer'> {
  return LANDING_CODE_STAGES[code] ?? 'optimize';
}

export function landingErrorCode(job: Pick<LandingJob, 'errorCode' | 'error'>): string {
  // An older agent refused with a code in `error`; only one from the closed list is taken.
  return safeErrorCode(job.errorCode ?? knownErrorCode(LANDING_ERROR_CODES, job.error));
}

/** `error_occurred` for a landing run that just failed, correlated by its `run_id`. */
export function landingFailureError(
  job: Pick<LandingJob, 'errorCode' | 'error'>,
  runId?: string
): AnalyticsProperties {
  const code = landingErrorCode(job);
  return toolErrorProperties({
    tool: 'landing-optimizer',
    stage: landingErrorStage(code),
    code,
    ...(runId ? { runId } : {})
  });
}
