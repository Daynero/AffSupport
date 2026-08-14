import type {
  LibraryJobKind,
  TeamFileOperationResult,
  TeamTransferGrant
} from '@video-compressor/shared';
import type { TeamProcessBridge } from './process.js';
import { createVideoThumbnailMetadata, type VideoThumbnailMetadata } from './thumbnail.js';

export interface CreativeLibraryProcessRequest {
  operationId: string;
  teamId: string;
  requirementId: string;
  attemptId: string;
  agentInstanceId: string;
  kind: LibraryJobKind;
  variant: string;
  sourceVersion: string;
  leaseToken: string;
  transferUrl: string;
  cloudBaseUrl: string;
  sourceGrant: TeamTransferGrant;
  finalizeGrant: TeamTransferGrant;
  options: unknown;
}

export interface CreativeLibraryProcessBridgeOptions {
  /** Existing team process coordinator; this module never starts a second worker runtime. */
  process: Pick<TeamProcessBridge, 'process' | 'cancel'>;
  toolForKind?: Readonly<Partial<Record<LibraryJobKind, string>>>;
}

const DEFAULT_TOOL_FOR_KIND: Readonly<Partial<Record<LibraryJobKind, string>>> = {
  transcription: 'transcription',
  translation: 'translation',
  landing_optimization: 'landingOptimizer'
};

/**
 * Operation-scoped Creative Library facade over the existing local pipelines. It deliberately
 * owns no process spawning and keeps only opaque attempt ids in memory.
 */
export class CreativeLibraryProcessBridge {
  readonly #process: CreativeLibraryProcessBridgeOptions['process'];
  readonly #toolForKind: Readonly<Partial<Record<LibraryJobKind, string>>>;
  readonly #active = new Map<
    string,
    { operationId: string; promise: Promise<TeamFileOperationResult> }
  >();

  constructor(options: CreativeLibraryProcessBridgeOptions) {
    this.#process = options.process;
    this.#toolForKind = Object.freeze({
      ...DEFAULT_TOOL_FOR_KIND,
      ...(options.toolForKind ?? {})
    });
  }

  process(request: CreativeLibraryProcessRequest): Promise<TeamFileOperationResult> {
    if (this.#active.has(request.attemptId)) return Promise.reject(new Error('WRONG_STATE'));
    const toolId = this.#toolForKind[request.kind];
    if (!toolId) return Promise.reject(new Error('AGENT_UPDATE_REQUIRED'));
    const promise = this.#process.process({
      operationId: request.operationId,
      toolId,
      options: isRecord(request.options) ? request.options : {},
      transferUrl: request.transferUrl,
      cloudBaseUrl: request.cloudBaseUrl,
      sourceGrant: request.sourceGrant,
      finalizeGrant: request.finalizeGrant
    });
    this.#active.set(request.attemptId, { operationId: request.operationId, promise });
    void promise.finally(() => this.#active.delete(request.attemptId)).catch(() => undefined);
    return promise;
  }

  cancel(attemptId: string): boolean {
    const active = this.#active.get(attemptId);
    if (!active) return false;
    return this.#process.cancel(active.operationId);
  }

  busy(): boolean {
    return this.#active.size > 0;
  }

  /** Lightweight metadata only; frame extraction stays inside the existing local media tool. */
  thumbnailMetadata(input: {
    durationMs: number;
    width?: number | null;
    height?: number | null;
    sourceVersion: string;
  }): VideoThumbnailMetadata {
    return createVideoThumbnailMetadata(input);
  }

  async shutdown(): Promise<void> {
    for (const active of this.#active.values()) this.#process.cancel(active.operationId);
    await Promise.allSettled([...this.#active.values()].map(active => active.promise));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
