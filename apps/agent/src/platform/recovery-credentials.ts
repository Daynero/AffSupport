import { isRecord } from '@video-compressor/shared';
import { recoveryCredential, RECOVERY_SECRET_LOST } from './platform.js';
export { RECOVERY_SECRET_LOST };
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
    // What the store hands back is no longer a handle: it is lost, the same as one that no
    // longer decrypts (a retry reads the same bytes again, so it is never transient).
    let value: unknown;
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(raw)) throw new Error(RECOVERY_SECRET_LOST);
      value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      throw new Error(RECOVERY_SECRET_LOST);
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
      throw new Error(RECOVERY_SECRET_LOST);
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
