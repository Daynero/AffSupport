import { isRecord } from '@video-compressor/shared';
import { recoveryCredential } from './platform.js';
export interface RecoverySecrets {
  refresh: string;
  expiresAt: string;
  rotationId: string;
  claim: string | null;
  claimExpiresAt: string | null;
  active: Record<string, unknown> | null;
}
export interface RecoverySecretStore {
  read(account: string): Promise<RecoverySecrets | null>;
  write(account: string, value: RecoverySecrets): Promise<void>;
  delete(account: string): Promise<void>;
}
export const platformRecoverySecrets: RecoverySecretStore = {
  async read(account) {
    const raw = await recoveryCredential('read', account);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      throw new Error('INVALID_RESPONSE');
    }
    if (
      !isRecord(value) ||
      typeof value.refresh !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.refresh) ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      typeof value.rotationId !== 'string' ||
      !/^[0-9a-f-]{36}$/iu.test(value.rotationId) ||
      (value.claim !== null &&
        (typeof value.claim !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.claim))) ||
      (value.claimExpiresAt !== null &&
        (typeof value.claimExpiresAt !== 'string' ||
          !Number.isFinite(Date.parse(value.claimExpiresAt)))) ||
      (value.active !== null && !isRecord(value.active))
    )
      throw new Error('INVALID_RESPONSE');
    return {
      refresh: value.refresh,
      expiresAt: value.expiresAt,
      rotationId: value.rotationId,
      claim: value.claim,
      claimExpiresAt: value.claimExpiresAt,
      active: value.active
    };
  },
  async write(account, value) {
    await recoveryCredential(
      'write',
      account,
      Buffer.from(JSON.stringify(value)).toString('base64url')
    );
  },
  async delete(account) {
    await recoveryCredential('delete', account);
  }
};
