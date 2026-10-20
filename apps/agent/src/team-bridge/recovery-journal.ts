import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '@video-compressor/shared';

export interface RecoveryCheckpoint {
  delegationId: string;
  requestId: string;
  operationId: string | null;
  stage: 'claiming' | 'accepted' | 'running' | 'settled' | 'blocked';
  reason: string | null;
  updatedAt: string;
  retryEpisodes?: number[];
  retryNotBefore?: number;
  retryAttempt?: number;
  retrySince?: number;
}
export interface RecoveryRegistration {
  teamId: string;
  installationId: string;
  endpoint: string;
  delegationId: string;
  account: string;
}
const UUID = /^[0-9a-f-]{36}$/iu;
export function parseRecoveryCheckpoint(value: unknown): RecoveryCheckpoint | null {
  if (
    !isRecord(value) ||
    typeof value.delegationId !== 'string' ||
    !UUID.test(value.delegationId) ||
    typeof value.requestId !== 'string' ||
    !UUID.test(value.requestId) ||
    (value.operationId !== null &&
      (typeof value.operationId !== 'string' || !UUID.test(value.operationId))) ||
    !['claiming', 'accepted', 'running', 'settled', 'blocked'].includes(String(value.stage)) ||
    (value.reason !== null &&
      (typeof value.reason !== 'string' || !/^[a-z_]{1,48}$/u.test(value.reason))) ||
    (value.retryEpisodes !== undefined &&
      (!Array.isArray(value.retryEpisodes) ||
        value.retryEpisodes.length > 3 ||
        value.retryEpisodes.some(t => typeof t !== 'number' || !Number.isFinite(t) || t < 0))) ||
    (value.retryNotBefore !== undefined &&
      (typeof value.retryNotBefore !== 'number' ||
        !Number.isFinite(value.retryNotBefore) ||
        value.retryNotBefore < 0)) ||
    (value.retryAttempt !== undefined &&
      (typeof value.retryAttempt !== 'number' ||
        !Number.isInteger(value.retryAttempt) ||
        value.retryAttempt < 0 ||
        value.retryAttempt > 6)) ||
    (value.retrySince !== undefined &&
      (typeof value.retrySince !== 'number' ||
        !Number.isFinite(value.retrySince) ||
        value.retrySince < 0)) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    return null;
  return {
    delegationId: value.delegationId,
    requestId: value.requestId,
    operationId: value.operationId,
    stage: value.stage as RecoveryCheckpoint['stage'],
    reason: value.reason,
    updatedAt: value.updatedAt,
    ...(Array.isArray(value.retryEpisodes)
      ? { retryEpisodes: value.retryEpisodes as number[] }
      : {}),
    ...(typeof value.retryAttempt === 'number' ? { retryAttempt: value.retryAttempt } : {}),
    ...(typeof value.retrySince === 'number' ? { retrySince: value.retrySince } : {}),
    ...(typeof value.retryNotBefore === 'number' ? { retryNotBefore: value.retryNotBefore } : {})
  };
}
/** Atomic, environment-scoped metadata only. Secrets live in platform storage. */
export class RecoveryJournal {
  #chain: Promise<void> = Promise.resolve();
  constructor(readonly root: string) {}
  async load(): Promise<{
    registrations: RecoveryRegistration[];
    checkpoints: RecoveryCheckpoint[];
  }> {
    const file = path.join(this.root, 'recovery.json');
    let value: unknown;
    try {
      if ((await stat(file)).size > 256 * 1024) throw new Error('INVALID_RESPONSE');
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return { registrations: [], checkpoints: [] };
      throw new Error('INVALID_RESPONSE', { cause: error });
    }
    if (
      !isRecord(value) ||
      !Array.isArray(value.registrations) ||
      !Array.isArray(value.checkpoints) ||
      value.registrations.length > 6 ||
      value.checkpoints.length > 6
    )
      throw new Error('INVALID_RESPONSE');
    const registrations: RecoveryRegistration[] = [];
    for (const item of value.registrations) {
      if (
        !isRecord(item) ||
        typeof item.teamId !== 'string' ||
        !UUID.test(item.teamId) ||
        typeof item.installationId !== 'string' ||
        !UUID.test(item.installationId) ||
        typeof item.delegationId !== 'string' ||
        !UUID.test(item.delegationId) ||
        typeof item.endpoint !== 'string' ||
        item.endpoint.length > 2048 ||
        typeof item.account !== 'string' ||
        !/^soty-recovery-[a-z0-9-]{1,100}$/u.test(item.account)
      )
        throw new Error('INVALID_RESPONSE');
      registrations.push({
        teamId: item.teamId,
        installationId: item.installationId,
        delegationId: item.delegationId,
        endpoint: item.endpoint,
        account: item.account
      });
    }
    const checkpoints = value.checkpoints.map(parseRecoveryCheckpoint);
    if (checkpoints.some(item => !item)) throw new Error('INVALID_RESPONSE');
    return {
      registrations,
      checkpoints: checkpoints.filter((item): item is RecoveryCheckpoint => item !== null)
    };
  }
  async quarantine(): Promise<void> {
    // Fixed destination bounds damaged metadata to one copy; never replay guessed state.
    await rename(
      path.join(this.root, 'recovery.json'),
      path.join(this.root, 'recovery.corrupt.json')
    );
  }
  save(value: {
    registrations: RecoveryRegistration[];
    checkpoints: RecoveryCheckpoint[];
  }): Promise<void> {
    const data = JSON.stringify(value);
    if (data.length > 256 * 1024 || value.registrations.length > 6 || value.checkpoints.length > 6)
      return Promise.reject(new Error('TOO_LARGE'));
    const task = this.#chain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const temp = path.join(this.root, `.${randomUUID()}.tmp`);
        try {
          await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
          await rename(temp, path.join(this.root, 'recovery.json'));
        } finally {
          await rm(temp, { force: true });
        }
      });
    this.#chain = task;
    return task;
  }
}
