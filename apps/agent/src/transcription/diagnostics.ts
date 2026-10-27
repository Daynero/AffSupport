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
    code?: TranscriptionErrorCode | null
  ): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('terminal', {
      ...this.ids,
      outcome,
      last_stage: this.last,
      omitted_stage_count: this.omitted,
      ...(code ? { error_code: code } : {})
    });
  }
}

/** A refused legacy command has no execution attempt or fabricated operation start. */
export function recordRetiredCommand(): void {
  diagnostics.record('transcription', 'feature_retired', {
    api_version: AGENT_API_VERSION,
    error_code: 'FEATURE_RETIRED'
  });
}
