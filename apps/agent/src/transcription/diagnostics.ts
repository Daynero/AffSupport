import { AGENT_API_VERSION, type TranscriptionErrorCode } from '@video-compressor/shared';
import { diagnostics, type DiagnosticProps } from '../server/diagnostics-log.js';

export type OriginalStage = 'input' | 'extract' | 'transcribe' | 'recover' | 'save' | 'saved';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type Emit = (code: string, props: DiagnosticProps) => void;
/** Only the bridge's exact opaque operation identity may become a run ID. */
export function transcriptionDiagnosticRunId(jobId: string, sourceKey: string | null): string {
  return (
    /^team:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu
      .exec(sourceKey ?? '')?.[1]
      ?.toLowerCase() ?? jobId
  );
}

/** Twelve records at most, irrespective of how many recovery windows Whisper needs. */
export class TranscriptionAttemptJournal {
  private last: OriginalStage | 'accepted' = 'accepted';
  private intermediate = 0;
  private omitted = 0;
  private saved = false;
  private ended = false;
  private readonly ids: DiagnosticProps;
  constructor(
    jobId: string,
    attemptId: string,
    private readonly emit: Emit = (code, props) => diagnostics.record('transcription', code, props),
    runId: string = jobId
  ) {
    if (!UUID.test(attemptId)) throw new Error('INVALID_DIAGNOSTIC_ID');
    this.ids = {
      ...(UUID.test(jobId) ? { flow_id: jobId.toLowerCase() } : {}),
      ...(UUID.test(runId) ? { run_id: runId.toLowerCase() } : {}),
      attempt_id: attemptId,
      api_version: AGENT_API_VERSION
    };
    this.emit('accepted', this.ids);
  }
  stage(stage: OriginalStage): void {
    if (this.ended || stage === this.last) return;
    this.last = stage;
    if (stage === 'saved') {
      if (!this.saved) this.emit('stage', { ...this.ids, stage });
      this.saved = true;
    } else if (this.intermediate < 8) {
      this.intermediate++;
      this.emit('stage', { ...this.ids, stage });
    } else if (++this.omitted === 1) this.emit('stages_omitted', this.ids);
  }
  terminal(
    outcome: 'success' | 'failure' | 'cancelled' | 'interrupted',
    code?: TranscriptionErrorCode | null,
    failure?: TranscriptionFailureDetail | null
  ): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('terminal', {
      ...this.ids,
      outcome,
      last_stage: this.last,
      omitted_stage_count: this.omitted,
      ...(code ? { error_code: code } : {}),
      ...(failure ? { failure_cause: failure.cause } : {}),
      ...(failure && failure.exitCode !== null ? { exit_code: failure.exitCode } : {})
    });
  }
}

export interface TranscriptionFailureDetail {
  cause: TranscriptionFailureCause;
  exitCode: number | null;
}
export type TranscriptionFailureCause =
  | 'tool_not_started'
  | 'runtime_library_missing'
  | 'illegal_instruction'
  | 'crashed'
  | 'out_of_memory'
  | 'model_load_failed'
  | 'disk_full'
  | 'output_missing'
  | 'speech_not_transcribed'
  | 'exit_nonzero';

/** Windows NTSTATUS exit codes as Node reports them (unsigned) and as signed 32-bit. */
const STATUS_DLL_NOT_FOUND = [0xc0000135, -1073741515];
const STATUS_ENTRYPOINT_NOT_FOUND = [0xc0000139, -1073741511];
const STATUS_ILLEGAL_INSTRUCTION = [0xc000001d, -1073741795];
const STATUS_ACCESS_VIOLATION = [0xc0000005, -1073741819];
const STATUS_STACK_BUFFER_OVERRUN = [0xc0000409, -1073740791];

/**
 * Why whisper or FFmpeg ended a transcription without a transcript, in a closed vocabulary
 * the journal may carry (production 2026-11-12: a Windows machine without the Visual C++
 * runtime failed every transcription with only TRANSCRIBE_FAILED to show for it). Nothing
 * of stderr itself is recorded — it can name files — only the class read from it.
 */
export function transcriptionFailureDetail(result: {
  code: number | null;
  spawnErrorCode: string | null;
  stderr: string;
}): TranscriptionFailureDetail {
  const exitCode =
    typeof result.code === 'number' && Number.isFinite(result.code) ? result.code : null;
  const is = (codes: number[]) => exitCode !== null && codes.includes(exitCode);
  const cause: TranscriptionFailureCause = result.spawnErrorCode
    ? 'tool_not_started'
    : is(STATUS_DLL_NOT_FOUND) || is(STATUS_ENTRYPOINT_NOT_FOUND)
      ? 'runtime_library_missing'
      : is(STATUS_ILLEGAL_INSTRUCTION)
        ? 'illegal_instruction'
        : is(STATUS_ACCESS_VIOLATION) || is(STATUS_STACK_BUFFER_OVERRUN)
          ? 'crashed'
          : /no space left on device/iu.test(result.stderr)
            ? 'disk_full'
            : /failed to allocate|out of memory|bad_alloc|cannot allocate/iu.test(result.stderr)
              ? 'out_of_memory'
              : /failed to (?:load model|initialize whisper context)|invalid model/iu.test(
                    result.stderr
                  )
                ? 'model_load_failed'
                : /WHISPER_OUTPUT_MISSING/u.test(result.stderr)
                  ? 'output_missing'
                  : /SPEECH_NOT_TRANSCRIBED/u.test(result.stderr)
                    ? 'speech_not_transcribed'
                    : 'exit_nonzero';
  return { cause, exitCode };
}

/** A refused legacy command has no execution attempt or fabricated operation start. */
export function recordRetiredCommand(): void {
  diagnostics.record('transcription', 'feature_retired', {
    api_version: AGENT_API_VERSION,
    error_code: 'FEATURE_RETIRED'
  });
}
