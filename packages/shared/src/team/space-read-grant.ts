// @ts-self-types="./space-read-grant.d.ts"
import { SPACE_STORAGE_LIMITS, isSpaceUuid } from './space-storage.js';

/**
 * The read grant of an R2 space (057 research R4, contracts/storage-api.md).
 *
 * `space-storage` signs it, the `space-read` Worker verifies it: one module on
 * WebCrypto, so Deno and the Worker run the same bytes. HMAC-SHA-256 over a
 * fixed binary payload — version, environment, key version, team, user,
 * `access_epoch`, issued and expiry seconds. A grant opens one space for at
 * most ten minutes; raising the space's `access_epoch` revokes every grant
 * already issued. The token rides in `?g=`, so it must never be logged.
 */
export type SpaceGrantEnvironment = 'dev' | 'beta' | 'production';
const ENVIRONMENTS: readonly SpaceGrantEnvironment[] = ['dev', 'beta', 'production'];

export interface SpaceReadGrantClaims {
  environment: SpaceGrantEnvironment;
  keyVersion: number;
  teamId: string;
  userId: string;
  accessEpoch: bigint;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds; at most `readGrantTtlSeconds` after `issuedAt`. */
  expiresAt: number;
}

export type SpaceReadGrantRejection = 'malformed' | 'signature' | 'expired' | 'team' | 'epoch';
export type SpaceReadGrantVerdict =
  { ok: true; claims: SpaceReadGrantClaims } | { ok: false; reason: SpaceReadGrantRejection };

const VERSION = 1;
const PAYLOAD_BYTES = 1 + 1 + 2 + 16 + 16 + 8 + 8 + 8;
const SIGNATURE_BYTES = 32;
const TOKEN_BYTES = PAYLOAD_BYTES + SIGNATURE_BYTES;
/** Clock skew tolerated between the signer and the Worker. */
const SKEW_SECONDS = 30;

const encode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

function decode(token: string): Uint8Array<ArrayBuffer> | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{123}$/u.test(token)) return null;
  try {
    const text = atob(token.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
    return bytes.length === TOKEN_BYTES && encode(bytes) === token ? bytes : null;
  } catch {
    return null;
  }
}

const uuidBytes = (uuid: string): Uint8Array => {
  const hex = uuid.replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, n) =>
    Number.parseInt(hex.slice(n * 2, n * 2 + 2), 16)
  );
};
const bytesUuid = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export async function importSpaceReadGrantKey(
  raw: Uint8Array,
  subtle: SubtleCrypto = crypto.subtle
): Promise<CryptoKey> {
  if (raw.length < 32 || raw.length > 128) throw new Error('Invalid space read grant key');
  return subtle.importKey(
    'raw',
    new Uint8Array(raw).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function validClaims(claims: SpaceReadGrantClaims): boolean {
  return (
    ENVIRONMENTS.includes(claims.environment) &&
    Number.isSafeInteger(claims.keyVersion) &&
    claims.keyVersion >= 1 &&
    claims.keyVersion <= 65535 &&
    isSpaceUuid(claims.teamId) &&
    isSpaceUuid(claims.userId) &&
    typeof claims.accessEpoch === 'bigint' &&
    claims.accessEpoch >= 0n &&
    claims.accessEpoch <= 9_223_372_036_854_775_807n &&
    Number.isSafeInteger(claims.issuedAt) &&
    Number.isSafeInteger(claims.expiresAt) &&
    claims.issuedAt > 0 &&
    claims.expiresAt > claims.issuedAt &&
    claims.expiresAt - claims.issuedAt <= SPACE_STORAGE_LIMITS.readGrantTtlSeconds
  );
}

export async function signSpaceReadGrant(
  claims: SpaceReadGrantClaims,
  key: CryptoKey,
  subtle: SubtleCrypto = crypto.subtle
): Promise<string> {
  if (!validClaims(claims)) throw new Error('Invalid space read grant claims');
  const payload = new Uint8Array(PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  payload[0] = VERSION;
  payload[1] = ENVIRONMENTS.indexOf(claims.environment) + 1;
  view.setUint16(2, claims.keyVersion);
  payload.set(uuidBytes(claims.teamId), 4);
  payload.set(uuidBytes(claims.userId), 20);
  view.setBigUint64(36, claims.accessEpoch);
  view.setBigUint64(44, BigInt(claims.issuedAt));
  view.setBigUint64(52, BigInt(claims.expiresAt));
  const signature = new Uint8Array(await subtle.sign('HMAC', key, payload.buffer));
  const token = new Uint8Array(TOKEN_BYTES);
  token.set(payload);
  token.set(signature, PAYLOAD_BYTES);
  return encode(token);
}

/** Read the claims without trusting them — for choosing a key version only. */
export function peekSpaceReadGrantKeyVersion(token: string): number | null {
  const bytes = decode(token);
  return bytes && bytes[0] === VERSION ? new DataView(bytes.buffer).getUint16(2) : null;
}

/**
 * Verify in the order the contract fixes: signature and expiry, then the team
 * in the path, then the space's current `access_epoch` when the caller has it.
 * The Worker passes `currentEpoch` from its ≤30 s cache; omitting it checks
 * only what the token itself proves.
 */
export async function verifySpaceReadGrant(
  token: string,
  options: {
    environment: SpaceGrantEnvironment;
    keys: ReadonlyMap<number, CryptoKey>;
    teamId: string;
    nowSeconds: number;
    currentEpoch?: bigint;
  },
  subtle: SubtleCrypto = crypto.subtle
): Promise<SpaceReadGrantVerdict> {
  const bytes = decode(token);
  if (!bytes || bytes[0] !== VERSION || bytes[1] !== ENVIRONMENTS.indexOf(options.environment) + 1)
    return { ok: false, reason: 'malformed' };
  const view = new DataView(bytes.buffer);
  const key = options.keys.get(view.getUint16(2));
  if (!key) return { ok: false, reason: 'signature' };
  const signed = await subtle.verify(
    'HMAC',
    key,
    bytes.slice(PAYLOAD_BYTES).buffer,
    bytes.slice(0, PAYLOAD_BYTES).buffer
  );
  if (!signed) return { ok: false, reason: 'signature' };
  const claims: SpaceReadGrantClaims = {
    environment: options.environment,
    keyVersion: view.getUint16(2),
    teamId: bytesUuid(bytes.slice(4, 20)),
    userId: bytesUuid(bytes.slice(20, 36)),
    accessEpoch: view.getBigUint64(36),
    issuedAt: Number(view.getBigUint64(44)),
    expiresAt: Number(view.getBigUint64(52))
  };
  if (!validClaims(claims)) return { ok: false, reason: 'malformed' };
  if (claims.expiresAt <= options.nowSeconds || claims.issuedAt > options.nowSeconds + SKEW_SECONDS)
    return { ok: false, reason: 'expired' };
  if (claims.teamId !== options.teamId) return { ok: false, reason: 'team' };
  if (options.currentEpoch !== undefined && claims.accessEpoch !== options.currentEpoch)
    return { ok: false, reason: 'epoch' };
  return { ok: true, claims };
}
