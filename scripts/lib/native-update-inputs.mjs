import { readFile, lstat } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readNativeUpdateQualification } from './native-update-qualification.mjs';
/** Read-only, before heavy release work. No key material or paths in the result. */
export async function nativeUpdateInputsPreflight(root, sourceSha, env = process.env) {
  if (env.SOTY_MACOS_TRUST_POLICY === 'adhoc-pre-048') return { enabled: false, legacy: true };
  const pins = JSON.parse(await readFile(path.join(root, 'config/native-updates.json'), 'utf8'));
  const file =
    env.SOTY_UPDATER_KEY_PATH ??
    path.join(os.homedir(), 'Library/Application Support/Soty/signing/updater-stable.seed');
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error('NATIVE_UPDATE_KEY_REQUIRED');
  const seed = Buffer.from((await readFile(file, 'utf8')).trim(), 'base64');
  if (seed.length !== 32) throw new Error('NATIVE_UPDATE_KEY_INVALID');
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8'
  });
  const publicX = createPublicKey(key).export({ format: 'jwk' }).x;
  if (
    typeof publicX !== 'string' ||
    Buffer.from(publicX, 'base64url').toString('base64') !== pins.stable.publicKey
  )
    throw new Error('NATIVE_UPDATE_KEY_PIN_MISMATCH');
  await readNativeUpdateQualification(env.SOTY_NATIVE_UPDATE_QUALIFICATION, sourceSha);
  return { enabled: true, keyMatches: true, qualificationSource: sourceSha };
}
