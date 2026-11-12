// @ts-self-types="./catalog-global-alias.d.ts"
import { isGlobalImageId } from './catalog-global-images.js';

export type GlobalAliasEnvironment = 'dev' | 'beta' | 'production';
export interface GlobalAliasClaims {
  environment: GlobalAliasEnvironment;
  keyVersion: number;
  imageId: string;
  generation: number;
  mime: 'image/jpeg' | 'image/png';
}
const ENVIRONMENTS: readonly GlobalAliasEnvironment[] = ['dev', 'beta', 'production'];
const PAYLOAD_BYTES = 29;
const SIGNATURE_BYTES = 32;
const TOKEN_BYTES = PAYLOAD_BYTES + SIGNATURE_BYTES;
const encode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
function decode(token: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{82}$/u.test(token)) return null;
  try {
    const text = atob(token.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
    return bytes.length === TOKEN_BYTES && encode(bytes) === token ? bytes : null;
  } catch {
    return null;
  }
}
export async function importGlobalAliasKey(
  raw: Uint8Array,
  subtle: SubtleCrypto = crypto.subtle
): Promise<CryptoKey> {
  if (raw.length < 32 || raw.length > 128) throw new Error('Invalid global media key');
  return subtle.importKey(
    'raw',
    new Uint8Array(raw).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}
export async function signGlobalImageAlias(
  claims: GlobalAliasClaims,
  key: CryptoKey,
  subtle: SubtleCrypto = crypto.subtle
): Promise<string> {
  if (
    !isGlobalImageId(claims.imageId) ||
    !ENVIRONMENTS.includes(claims.environment) ||
    !Number.isSafeInteger(claims.keyVersion) ||
    claims.keyVersion < 1 ||
    claims.keyVersion > 65535 ||
    !Number.isSafeInteger(claims.generation) ||
    claims.generation < 1 ||
    !['image/jpeg', 'image/png'].includes(claims.mime)
  )
    throw new Error('Invalid global media claims');
  const payload = new Uint8Array(PAYLOAD_BYTES),
    view = new DataView(payload.buffer);
  payload[0] = 1;
  payload[1] = ENVIRONMENTS.indexOf(claims.environment) + 1;
  view.setUint16(2, claims.keyVersion);
  payload[4] = claims.mime === 'image/jpeg' ? 1 : 2;
  const hex = claims.imageId.replaceAll('-', '');
  for (let n = 0; n < 16; n++) payload[5 + n] = Number.parseInt(hex.slice(n * 2, n * 2 + 2), 16);
  view.setBigUint64(21, BigInt(claims.generation));
  const signature = new Uint8Array(await subtle.sign('HMAC', key, payload.buffer));
  const token = new Uint8Array(TOKEN_BYTES);
  token.set(payload);
  token.set(signature, PAYLOAD_BYTES);
  return encode(token);
}
export async function verifyGlobalImageAlias(
  token: string,
  environment: GlobalAliasEnvironment,
  keys: ReadonlyMap<number, CryptoKey>,
  subtle: SubtleCrypto = crypto.subtle
): Promise<GlobalAliasClaims | null> {
  const bytes = decode(token);
  if (!bytes || bytes[0] !== 1 || bytes[1] !== ENVIRONMENTS.indexOf(environment) + 1) return null;
  const view = new DataView(bytes.buffer),
    keyVersion = view.getUint16(2),
    key = keys.get(keyVersion);
  const generation = Number(view.getBigUint64(21));
  if (!key || !Number.isSafeInteger(generation) || generation < 1 || ![1, 2].includes(bytes[4]!))
    return null;
  if (
    !(await subtle.verify(
      'HMAC',
      key,
      bytes.slice(PAYLOAD_BYTES).buffer,
      bytes.slice(0, PAYLOAD_BYTES).buffer
    ))
  )
    return null;
  const hex = Array.from(bytes.slice(5, 21), n => n.toString(16).padStart(2, '0')).join('');
  const imageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!isGlobalImageId(imageId)) return null;
  return {
    environment,
    keyVersion,
    imageId,
    generation,
    mime: bytes[4] === 1 ? 'image/jpeg' : 'image/png'
  };
}
