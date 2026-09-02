import { constants } from 'node:fs';
import { copyFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { TeamTransferGrant } from '@video-compressor/shared';
import { selectOutputFolder } from '../files/picker.js';
import { sanitizeFileName, showInFileManager } from '../platform/platform.js';
import type { TeamOperationEvents } from './events.js';
import type { TeamProcessDelegate } from './process.js';
import type { DownloadedTeamSource, TeamSourceDownloadRequest } from './transfer.js';

const MAX_NAME_ATTEMPTS = 1_000;

/**
 * What to do with the file between fetching it and saving it.
 *
 * A discriminated shape rather than a second optional flag, because the two tools want
 * different things: the compressor wants an embed switch and a name ending, a re-stitch wants
 * the space's defaults and — when somebody already looked at this material — what they found.
 */
export type TeamAgentDownloadProcess =
  | { tool: 'compressor'; embed: boolean; suffix: string }
  | { tool: 'restitch'; defaults: unknown; prepared?: unknown; suffix?: string };

export interface TeamAgentDownloadRequest {
  operationId: string;
  transferUrl: string;
  transferGrant: TeamTransferGrant;
  fileName: string;
  /**
   * A folder the caller already chose for this space.
   *
   * Without it the native picker opens, which is right the first time and wrong every time
   * after: a folder dialog in the middle of a ten-second promise is the thing this feature
   * exists to remove.
   */
  destination?: string | null;
  process?: TeamAgentDownloadProcess | null;
  /** 013 (B5)'s spelling, still accepted so a web and an agent build may differ by one step. */
  compress?: { embed: boolean; suffix: string } | null;
}

export interface TeamDownloadTransfer {
  downloadSource(
    request: TeamSourceDownloadRequest,
    signal: AbortSignal
  ): Promise<DownloadedTeamSource>;
}

export interface TeamDownloadBridgeOptions {
  transfer: TeamDownloadTransfer;
  chooseDestination?: () => Promise<string | null>;
  reveal?: (file: string) => void;
  /** Local delegates: 'compressor', 'imageEmbedding', and 015's 'restitch'. */
  delegates?: Readonly<Record<string, TeamProcessDelegate>>;
  /**
   * Where a running delivery's progress goes.
   *
   * A download has never published anything, because there was nothing to watch. A delivery
   * that fetches, inspects, re-stitches and saves is a different thing to wait for, and the
   * row that asked for it shows the phase it is in.
   */
  events?: TeamOperationEvents;
}

/** Saves an agent-only download after an explicit native destination choice. */
export class TeamDownloadBridge {
  readonly #transfer: TeamDownloadTransfer;
  readonly #chooseDestination: () => Promise<string | null>;
  readonly #reveal: (file: string) => void;
  readonly #delegates: Readonly<Record<string, TeamProcessDelegate>> | null;
  readonly #active = new Map<string, AbortController>();
  readonly #events: TeamOperationEvents | null;

  constructor(options: TeamDownloadBridgeOptions) {
    this.#transfer = options.transfer;
    this.#delegates = options.delegates ?? null;
    this.#chooseDestination = options.chooseDestination ?? selectOutputFolder;
    // Through the same guarded door as every other reveal: a downloaded file
    // is exactly the kind of path worth checking before handing it to the
    // system's "do whatever this is" verb.
    this.#reveal = options.reveal ?? (target => void showInFileManager(target, { reveal: true }));
    this.#events = options.events ?? null;
  }

  /** Bound per run, so a delegate reports without knowing who is listening. */
  #progress(operationId: string): (progress: number) => void {
    const events = this.#events;
    if (!events) return () => {};
    return progress => {
      events.update(operationId, { state: 'running', stage: 'processing', progress });
    };
  }

  async download(request: TeamAgentDownloadRequest) {
    const fileName = safeDownloadName(request.fileName);
    if (this.#active.has(request.operationId)) throw new Error('WRONG_STATE');
    const step = normalizeProcess(request);
    const destination = request.destination ?? (await this.#chooseDestination());
    if (!destination) throw new Error('DOWNLOAD_CANCELED');
    const destinationRoot = await realpath(destination);
    if (!(await lstat(destinationRoot)).isDirectory()) throw new Error('INVALID_INPUT');

    const controller = new AbortController();
    this.#active.set(request.operationId, controller);
    let source: DownloadedTeamSource | null = null;
    this.#events?.update(request.operationId, {
      state: 'running',
      stage: 'downloading',
      progress: 0
    });
    try {
      source = await this.#transfer.downloadSource(
        {
          operationId: request.operationId,
          transferUrl: request.transferUrl,
          grant: request.transferGrant
        },
        controller.signal
      );
      let produced = source.file;
      let producedCleanup: (() => Promise<void>) | null = null;
      let finalName = fileName;
      let discovered: unknown = null;
      if (step) {
        const delegate = this.#delegates?.[step.delegate];
        if (!delegate) throw new Error('UNSUPPORTED_MEDIA');
        const output = await delegate({
          operationId: `local:${request.operationId}`,
          workspace: source.workspace,
          sourceFile: source.file,
          sourceSizeBytes: source.sizeBytes,
          sourceVersion: source.sourceVersion,
          sourceChecksum: source.sourceChecksum,
          options: step.options,
          signal: controller.signal,
          onProgress: this.#progress(request.operationId),
          // A download-and-process has no interface of its own to pause from;
          // the offer is accepted and dropped.
          pausable: () => {}
        });
        produced = output.file;
        producedCleanup = output.cleanup ?? null;
        discovered = output.discovered ?? null;
        // Never the bare original: the two files land in the same folder, and one of them
        // has half an hour of photograph on the end.
        const extension = path.extname(fileName);
        const stem = fileName.slice(0, fileName.length - extension.length);
        const suffix = sanitizeFileName(step.suffix).slice(0, 60) || step.fallbackSuffix;
        finalName = safeDownloadName(`${stem}${suffix}.mp4`);
      }
      try {
        const target = await copyWithoutOverwrite(produced, destinationRoot, finalName);
        this.#reveal(target);
        const written = await lstat(target);
        this.#events?.update(request.operationId, { state: 'succeeded', stage: 'completed' });
        return {
          saved: true as const,
          fileName: path.basename(target),
          sizeBytes: written.size,
          // Present only when the run had to look for itself; the caller stores it so the
          // next delivery of this material does not.
          ...(discovered ? { discovered } : {})
        };
      } finally {
        await producedCleanup?.().catch(() => undefined);
      }
    } catch (error) {
      const canceled = controller.signal.aborted;
      this.#events?.update(request.operationId, {
        state: canceled ? 'canceled' : 'failed',
        stage: canceled ? 'canceled' : 'failed',
        errorCode: error instanceof Error ? error.message : 'DOWNLOAD_FAILED'
      });
      if (canceled) throw new Error('DOWNLOAD_CANCELED', { cause: error });
      throw error;
    } finally {
      this.#active.delete(request.operationId);
      await source?.cleanup().catch(() => undefined);
    }
  }

  cancel(operationId: string): boolean {
    const controller = this.#active.get(operationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  busy(): boolean {
    return this.#active.size > 0;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.#active.values()) controller.abort();
  }
}

function safeDownloadName(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) {
    throw new Error('INVALID_INPUT');
  }
  const safe = sanitizeFileName(value);
  if (!safe || safe === '.' || safe === '..') throw new Error('INVALID_INPUT');
  return safe;
}

async function copyWithoutOverwrite(source: string, destinationRoot: string, fileName: string) {
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidateName = attempt === 0 ? fileName : `${stem} (${attempt})${extension}`;
    const candidate = path.join(destinationRoot, candidateName);
    if (path.dirname(candidate) !== destinationRoot) throw new Error('INVALID_INPUT');
    try {
      await copyFile(source, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('NAME_CONFLICT');
}

interface NormalizedProcess {
  delegate: string;
  options: unknown;
  suffix: string;
  fallbackSuffix: string;
}

/**
 * One shape out of two spellings.
 *
 * `compress` is 013's; `process` is this feature's. Both are accepted for a release so that a
 * web build and an agent build may differ by one step, which the tool-contract range already
 * allows for everything else.
 */
function normalizeProcess(request: TeamAgentDownloadRequest): NormalizedProcess | null {
  const step = request.process;
  if (step?.tool === 'restitch') {
    return {
      delegate: 'restitch',
      options: { defaults: step.defaults, prepared: step.prepared ?? null },
      suffix: step.suffix ?? '',
      fallbackSuffix: '_restitched'
    };
  }
  const legacy = step?.tool === 'compressor' ? step : (request.compress ?? null);
  if (!legacy) return null;
  return {
    delegate: legacy.embed ? 'imageEmbedding' : 'compressor',
    options: {},
    suffix: legacy.suffix,
    fallbackSuffix: '_1'
  };
}
