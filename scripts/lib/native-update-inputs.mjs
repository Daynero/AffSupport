import { readFile, lstat } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readNativeUpdateQualification } from './native-update-qualification.mjs';
/**
 * Owner decision 2026-11-16: a release publishes to next with the native updater
 * enabled while the formal qualification record is still being collected. The
 * record is not waived, only moved: `release:channel -- promote` refuses a build
 * whose signed manifest advertises native updates until a valid record for the
 * descriptor's exact source revision is supplied (release-channel/operations.mjs).
 */
export const NATIVE_UPDATES_QUALIFICATION_DEFERRED = 'qualification-deferred-until-promote';
/**
 * The owner's native-updater policy for a Developer ID build, from
 * `SOTY_NATIVE_UPDATES`:
 * - unset or empty: `enabled` -- the qualification record is required at build time;
 * - `disabled` (2026-11-14): compiled in but switched off, no descriptor is signed;
 * - `qualification-deferred-until-promote` (2026-11-16): `deferred` -- enabled for
 *   next; the record is required before promote instead of before packaging.
 * Any other value is a typo and fails closed rather than silently choosing a side.
 * @returns {'enabled' | 'disabled' | 'deferred'}
 */
export function nativeUpdatePolicy(env = process.env) {
  const value = env.SOTY_NATIVE_UPDATES;
  if (value === undefined || value === '') return 'enabled';
  if (value === 'disabled') return 'disabled';
  if (value === NATIVE_UPDATES_QUALIFICATION_DEFERRED) {
    // Supplying the record while asking to defer it is a contradiction, not a choice.
    if (env.SOTY_NATIVE_UPDATE_QUALIFICATION) throw new Error('NATIVE_UPDATES_POLICY_CONFLICT');
    return 'deferred';
  }
  throw new Error('NATIVE_UPDATES_POLICY_INVALID');
}
/** The owner's explicit choice to ship the updater compiled in but switched off. */
export function nativeUpdatesDisabled(env = process.env) {
  return nativeUpdatePolicy(env) === 'disabled';
}
/**
 * Read-only, before heavy release work. No key material or paths in the result.
 * `publishesToNext` says the run lands on the next address first; a deferred
 * qualification is only acceptable there, because promote is where it is enforced.
 */
export async function nativeUpdateInputsPreflight(
  root,
  sourceSha,
  env = process.env,
  { publishesToNext = false } = {}
) {
  if (env.SOTY_MACOS_TRUST_POLICY === 'adhoc-pre-048') return { enabled: false, legacy: true };
  const policy = nativeUpdatePolicy(env);
  if (policy === 'disabled') return { enabled: false, disabledByOwner: true };
  if (policy === 'deferred' && !publishesToNext)
    throw new Error('NATIVE_UPDATE_DEFERRAL_REQUIRES_NEXT');
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
  if (policy === 'deferred')
    return { enabled: true, keyMatches: true, qualification: 'deferred-until-promote' };
  await readNativeUpdateQualification(env.SOTY_NATIVE_UPDATE_QUALIFICATION, sourceSha);
  return { enabled: true, keyMatches: true, qualificationSource: sourceSha };
}
