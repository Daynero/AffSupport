import type { DiagnosticRecord } from '@video-compressor/shared';

export type TeamLocalOperationState = 'running' | 'succeeded' | 'failed' | 'canceled';
export type TeamLocalOperationStage =
  'downloading' | 'processing' | 'uploading' | 'finalizing' | 'completed' | 'canceled' | 'failed';

export interface TeamLocalOperationProgress {
  operationId: string;
  state: TeamLocalOperationState;
  stage: TeamLocalOperationStage;
  progress: number;
  errorCode: string | null;
  updatedAt: string;
}

export interface TeamOperationEvent {
  type: 'team:operations';
  operations: TeamLocalOperationProgress[];
}

/** Content-free local progress state used by the guarded team SSE route. */
export class TeamOperationEvents {
  readonly #operations = new Map<string, TeamLocalOperationProgress>();
  #notify: (event: TeamOperationEvent) => void;

  constructor(notify: (event: TeamOperationEvent) => void = () => undefined) {
    this.#notify = notify;
  }

  setNotify(notify: (event: TeamOperationEvent) => void): void {
    this.#notify = notify;
  }

  update(
    operationId: string,
    patch: Omit<Partial<TeamLocalOperationProgress>, 'operationId' | 'updatedAt'>
  ): TeamLocalOperationProgress {
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(operationId)) throw new Error('INVALID_INPUT');
    const current = this.#operations.get(operationId);
    const state = patch.state ?? current?.state ?? 'running';
    const stage = patch.stage ?? current?.stage ?? 'downloading';
    const progress = Math.min(
      100,
      Math.max(current?.progress ?? 0, Math.round(patch.progress ?? 0))
    );
    const next: TeamLocalOperationProgress = {
      operationId,
      state,
      stage,
      progress: state === 'succeeded' ? 100 : progress,
      errorCode: patch.errorCode === undefined ? (current?.errorCode ?? null) : patch.errorCode,
      updatedAt: new Date().toISOString()
    };
    this.#operations.set(operationId, next);
    this.#notify(this.snapshot());
    return next;
  }

  /** Restore only proven failures, never infer a result from a missing process. */
  restoreFailures(records: readonly DiagnosticRecord[]): void {
    const seen = new Set<string>();
    for (const record of [...records].reverse()) {
      const props = record.props;
      if (record.category !== 'team' || record.code !== 'process_terminal' || !props) continue;
      const id = props.operationId;
      if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      if (props.outcome !== 'failed' && props.outcome !== 'canceled') continue;
      if (this.#operations.has(id)) continue;
      const state = props.outcome;
      const code = props.errorCode;
      this.#operations.set(id, {
        operationId: id,
        state,
        stage: state,
        progress: 0,
        errorCode:
          typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)
            ? code
            : 'PROCESS_FAILED',
        updatedAt: new Date(record.at).toISOString()
      });
    }
  }

  remove(operationId: string): boolean {
    const removed = this.#operations.delete(operationId);
    if (removed) this.#notify(this.snapshot());
    return removed;
  }

  snapshot(): TeamOperationEvent {
    return {
      type: 'team:operations',
      operations: [...this.#operations.values()].sort((left, right) =>
        left.operationId.localeCompare(right.operationId)
      )
    };
  }
}
