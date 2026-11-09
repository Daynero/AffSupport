import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '@video-compressor/shared';
import {
  MAX_NATIVE_RESTITCH_RECORDS,
  NativeRestitchExecutorError,
  parseNativeRestitchCheckpoint,
  type NativeRestitchCheckpoint
} from './native-restitch-executor.js';

export const NATIVE_RESTITCH_JOURNAL_BYTES = 64 * 1024;
type JournalFailure =
  'journal_read_failed' | 'journal_invalid' | 'journal_write_failed' | 'journal_disk_full';
export class NativeRestitchJournalError extends NativeRestitchExecutorError {
  constructor(readonly reason: JournalFailure) {
    super('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  }
}
function records(values: unknown): NativeRestitchCheckpoint[] {
  if (!Array.isArray(values) || values.length > MAX_NATIVE_RESTITCH_RECORDS)
    throw new NativeRestitchJournalError('journal_invalid');
  const result = values.map(parseNativeRestitchCheckpoint);
  if (new Set(result.map(value => value.identity.rootOperationId)).size !== result.length)
    throw new NativeRestitchJournalError('journal_invalid');
  return result;
}
/** Metadata only. A synced staged file and atomic replacement survive process
 * interruption. A missing/corrupt journal never proves old remote ownership is
 * closed: original server admission and range accounting remain authoritative. */
export class NativeRestitchJournal {
  readonly #file: string;
  #writes: Promise<void> = Promise.resolve();
  #observation: 'unread' | 'missing' | 'loaded' | 'unconfirmed' = 'unread';
  constructor(readonly root: string) {
    this.#file = path.join(root, 'restitch-executors.json');
  }
  observation() {
    return this.#observation;
  }
  async load(): Promise<NativeRestitchCheckpoint[]> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.#file, 'r');
    } catch (cause) {
      if (isRecord(cause) && cause.code === 'ENOENT') {
        this.#observation = 'missing';
        return [];
      }
      this.#observation = 'unconfirmed';
      throw new NativeRestitchJournalError('journal_read_failed');
    }
    let result: NativeRestitchCheckpoint[] | undefined;
    let failure: NativeRestitchJournalError | undefined;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(NATIVE_RESTITCH_JOURNAL_BYTES))
        throw new NativeRestitchJournalError('journal_invalid');
      // The fixed buffer also bounds concurrent growth after fstat. Read through
      // the original handle, never reopen a path that could have been replaced.
      const buffer = Buffer.alloc(NATIVE_RESTITCH_JOURNAL_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        total > NATIVE_RESTITCH_JOURNAL_BYTES ||
        before.size !== BigInt(total) ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs
      )
        throw new NativeRestitchJournalError('journal_invalid');
      const value: unknown = JSON.parse(buffer.subarray(0, total).toString('utf8'));
      if (!isRecord(value) || value.schemaVersion !== 1)
        throw new NativeRestitchJournalError('journal_invalid');
      result = records(value.records);
    } catch (cause) {
      this.#observation = 'unconfirmed';
      // Parser and filesystem messages can contain content or a raw path.
      failure =
        cause instanceof NativeRestitchJournalError
          ? cause
          : new NativeRestitchJournalError('journal_invalid');
    } finally {
      await handle.close().catch(() => {
        failure ??= new NativeRestitchJournalError('journal_read_failed');
      });
    }
    if (failure || !result) {
      this.#observation = 'unconfirmed';
      throw failure ?? new NativeRestitchJournalError('journal_read_failed');
    }
    this.#observation = 'loaded';
    return result;
  }
  save(values: readonly NativeRestitchCheckpoint[]): Promise<void> {
    let data: Buffer;
    try {
      data = Buffer.from(JSON.stringify({ schemaVersion: 1, records: records(values) }));
      if (data.length > NATIVE_RESTITCH_JOURNAL_BYTES)
        throw new NativeRestitchJournalError('journal_invalid');
    } catch {
      return Promise.reject(new NativeRestitchJournalError('journal_invalid'));
    }
    // Capture validated bytes before any await or another caller can mutate input.
    const write = this.#writes.catch(() => undefined).then(() => this.#write(data));
    this.#writes = write;
    return write;
  }
  async #write(data: Buffer): Promise<void> {
    const temporary = path.join(this.root, `.restitch-executors-${randomUUID()}.tmp`);
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#file);
      this.#observation = 'loaded';
    } catch (cause) {
      this.#observation = 'unconfirmed';
      throw new NativeRestitchJournalError(
        isRecord(cause) && cause.code === 'ENOSPC' ? 'journal_disk_full' : 'journal_write_failed'
      );
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
