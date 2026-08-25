import { constants } from 'node:fs';
import { copyFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { TeamTransferGrant } from '@video-compressor/shared';
import { selectOutputFolder } from '../files/picker.js';
import { sanitizeFileName, showInFileManager } from '../platform/platform.js';
import type { DownloadedTeamSource, TeamSourceDownloadRequest } from './transfer.js';

const MAX_NAME_ATTEMPTS = 1_000;

export interface TeamAgentDownloadRequest {
  operationId: string;
  transferUrl: string;
  transferGrant: TeamTransferGrant;
  fileName: string;
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
}

/** Saves an agent-only download after an explicit native destination choice. */
export class TeamDownloadBridge {
  readonly #transfer: TeamDownloadTransfer;
  readonly #chooseDestination: () => Promise<string | null>;
  readonly #reveal: (file: string) => void;
  readonly #active = new Map<string, AbortController>();

  constructor(options: TeamDownloadBridgeOptions) {
    this.#transfer = options.transfer;
    this.#chooseDestination = options.chooseDestination ?? selectOutputFolder;
    // Through the same guarded door as every other reveal: a downloaded file
    // is exactly the kind of path worth checking before handing it to the
    // system's "do whatever this is" verb.
    this.#reveal = options.reveal ?? (target => void showInFileManager(target, { reveal: true }));
  }

  async download(request: TeamAgentDownloadRequest) {
    const fileName = safeDownloadName(request.fileName);
    if (this.#active.has(request.operationId)) throw new Error('WRONG_STATE');
    const destination = await this.#chooseDestination();
    if (!destination) throw new Error('DOWNLOAD_CANCELED');
    const destinationRoot = await realpath(destination);
    if (!(await lstat(destinationRoot)).isDirectory()) throw new Error('INVALID_INPUT');

    const controller = new AbortController();
    this.#active.set(request.operationId, controller);
    let source: DownloadedTeamSource | null = null;
    try {
      source = await this.#transfer.downloadSource(
        {
          operationId: request.operationId,
          transferUrl: request.transferUrl,
          grant: request.transferGrant
        },
        controller.signal
      );
      const target = await copyWithoutOverwrite(source.file, destinationRoot, fileName);
      this.#reveal(target);
      return { saved: true as const, fileName: path.basename(target), sizeBytes: source.sizeBytes };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('DOWNLOAD_CANCELED', { cause: error });
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
