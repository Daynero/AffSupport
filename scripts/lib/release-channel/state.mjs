/**
 * Feature 051: where the release channel remembers what is on `next`, what is
 * on production and what a rollback returns to.
 *
 * The runner deploys from short-lived worktrees, so a record kept inside the
 * checkout that happened to deploy is a record nobody else can find -- which is
 * why `rollback:web` never once had a previous bundle to hand. The channel lives
 * in the repository's shared writer namespace (the same `release/automation`
 * every worktree's web-release lock already resolves to), next to that lock.
 *
 * Every write is a whole-file replacement (temp + rename + fsync) made while the
 * caller holds the web-release lock, plus one appended history line.
 */
import { cp, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  releaseManifestSigningPayload
} from '../../../packages/shared/dist/release.js';
import {
  isNativeUpdateDescriptor,
  nativeUpdateMatchesManifest
} from '../../../packages/shared/dist/native-app-updates.js';
import { outputDigest, readWebFile } from '../../release-web-meta.mjs';
import { webReleaseStateFile } from '../web-only-lock.mjs';

export const MANIFEST_PATH = '.well-known/wishly/stable.json';
export const INDEX_PATH = 'index.html';
/** Bundles kept beyond the ones the state still points at. */
export const EXTRA_BUNDLES = 5;
/** Previous production builds a rollback can still reach. */
export const PREVIOUS_KEPT = 5;

const HEX64 = /^[a-f0-9]{64}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;

export class ChannelError extends Error {
  /** @param {string} code @param {string} message @param {ErrorOptions} [options] */
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.code = code;
  }
}

/** @param {string} root @param {NodeJS.ProcessEnv} [env] */
export async function channelDirectory(root, env = process.env) {
  if (env.SOTY_RELEASE_CHANNEL_DIR) return path.resolve(env.SOTY_RELEASE_CHANNEL_DIR);
  const lock = await webReleaseStateFile(root, 'web-release.lock');
  return path.join(path.dirname(lock), 'release-channel');
}

/** @returns {ChannelState} */
export function emptyState() {
  return { schemaVersion: 1, next: null, production: null, previous: [] };
}

/** @param {unknown} record */
export function assertBuildRecord(record) {
  const r = /** @type {Record<string, unknown>} */ (record);
  if (
    !r ||
    typeof r !== 'object' ||
    !HEX64.test(String(r.outputDigest)) ||
    !HEX64.test(String(r.indexDigest)) ||
    !HEX64.test(String(r.manifestDigest)) ||
    (r.sourceSha !== null && !HEX40.test(String(r.sourceSha))) ||
    typeof r.version !== 'string' ||
    typeof r.buildId !== 'string' ||
    typeof r.deployedAt !== 'string' ||
    !Number.isFinite(Date.parse(String(r.deployedAt))) ||
    !['full', 'web-only', 'adopted'].includes(String(r.kind))
  )
    throw new ChannelError('CHANNEL_STATE_INVALID', 'a build record is malformed');
  return /** @type {BuildRecord} */ (record);
}

/** @param {unknown} value */
export function validateState(value) {
  const s = /** @type {any} */ (value);
  if (!s || s.schemaVersion !== 1 || !Array.isArray(s.previous))
    throw new ChannelError('CHANNEL_STATE_INVALID', 'state.json has an unknown shape');
  if (s.next !== null) {
    if (!['testing', 'cancelled', 'promoted'].includes(s.next?.status))
      throw new ChannelError('CHANNEL_STATE_INVALID', 'next has an unknown status');
    if (!Number.isInteger(s.next.builds) || s.next.builds < 1)
      throw new ChannelError('CHANNEL_STATE_INVALID', 'next has no build count');
    assertBuildRecord(s.next.build);
  }
  if (s.production !== null) assertBuildRecord(s.production);
  s.previous.forEach(assertBuildRecord);
  return /** @type {ChannelState} */ (s);
}

/** @param {string} dir */
export async function readState(dir) {
  let text;
  try {
    text = await readFile(path.join(dir, 'state.json'), 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ChannelError('CHANNEL_STATE_INVALID', 'state.json is not JSON', { cause: error });
  }
  return validateState(parsed);
}

/** @param {string} dir @param {ChannelState} state */
export async function writeState(dir, state) {
  validateState(state);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'state.json');
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directory = await open(dir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** @param {string} dir @param {Record<string, unknown>} entry */
export async function appendHistory(dir, entry) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = await open(path.join(dir, 'history.jsonl'), 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** @param {string} dir */
export async function readHistory(dir) {
  try {
    return (await readFile(path.join(dir, 'history.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
    throw error;
  }
}

export const sha256 = (/** @type {Buffer} */ bytes) =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Parses and verifies a signed stable manifest. Every bundle the channel moves
 * carries one, and a bundle whose manifest does not verify is never promoted or
 * restored: it would advertise downloads the site itself refuses to trust.
 *
 * @param {Buffer} bytes
 * @param {string} [publicKeySpki]
 */
export function verifiedManifest(bytes, publicKeySpki = RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ChannelError('CHANNEL_MANIFEST_INVALID', 'stable.json is not JSON');
  }
  const ok =
    manifest &&
    manifest.schemaVersion === 1 &&
    manifest.channel === 'stable' &&
    typeof manifest.version === 'string' &&
    typeof manifest.buildId === 'string' &&
    typeof manifest.signature === 'string' &&
    /^[A-Za-z0-9_-]+$/u.test(manifest.signature) &&
    verify(
      'sha256',
      Buffer.from(releaseManifestSigningPayload(manifest), 'utf8'),
      {
        key: createPublicKey({
          key: Buffer.from(publicKeySpki, 'base64'),
          format: 'der',
          type: 'spki'
        }),
        dsaEncoding: 'ieee-p1363'
      },
      Buffer.from(manifest.signature, 'base64url')
    );
  if (!ok)
    throw new ChannelError('CHANNEL_MANIFEST_INVALID', 'stable.json signature does not verify');
  if (manifest.nativeUpdates !== undefined) {
    if (
      !manifest.nativeUpdates ||
      typeof manifest.nativeUpdates !== 'object' ||
      Array.isArray(manifest.nativeUpdates) ||
      !Object.entries(manifest.nativeUpdates).every(
        ([target, candidate]) =>
          isNativeUpdateDescriptor(candidate) &&
          candidate.target === target &&
          candidate.channel === 'stable' &&
          nativeUpdateMatchesManifest(candidate, manifest)
      )
    )
      throw new ChannelError(
        'CHANNEL_NATIVE_UPDATE_INVALID',
        'native update metadata differs from the signed release identity'
      );
  }
  return manifest;
}

/**
 * What a bundle is, read from its own bytes.
 *
 * @param {string} directory
 * @param {{publicKeySpki?: string}} [options]
 */
export async function describeBundle(directory, { publicKeySpki } = {}) {
  const index = await readWebFile(directory, INDEX_PATH, 2 * 1024 * 1024);
  const manifestBytes = await readWebFile(directory, MANIFEST_PATH);
  const manifest = verifiedManifest(manifestBytes, publicKeySpki);
  return {
    outputDigest: await outputDigest(directory),
    indexDigest: sha256(index),
    manifestDigest: sha256(manifestBytes),
    version: manifest.version,
    buildId: manifest.buildId
  };
}

/** @param {string} dir @param {string} digest */
export function bundlePath(dir, digest) {
  if (!HEX64.test(digest)) throw new ChannelError('CHANNEL_STATE_INVALID', 'bad bundle digest');
  return path.join(dir, 'bundles', digest);
}

/**
 * Copies a bundle into the channel archive under its content digest. An existing
 * entry is reused only when it still hashes to its name.
 *
 * @param {string} dir @param {string} source @param {string} digest
 */
export async function archiveBundle(dir, source, digest) {
  const destination = bundlePath(dir, digest);
  const present = await stat(destination).then(
    () => true,
    () => false
  );
  if (present && (await outputDigest(destination)) === digest) return destination;
  if (present) await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await cp(source, temporary, { recursive: true });
  if ((await outputDigest(temporary)) !== digest) {
    await rm(temporary, { recursive: true, force: true });
    throw new ChannelError('CHANNEL_ARCHIVE_CHANGED', 'bundle changed while it was archived');
  }
  await rename(temporary, destination);
  return destination;
}

/**
 * The archived bytes for a record, proven to still be those bytes.
 *
 * @param {string} dir @param {BuildRecord} record
 */
export async function archivedBundle(dir, record) {
  const directory = bundlePath(dir, record.outputDigest);
  const exists = await stat(directory).then(
    () => true,
    () => false
  );
  if (!exists)
    throw new ChannelError(
      'CHANNEL_ARCHIVE_MISSING',
      `bundle ${record.outputDigest.slice(0, 12)} (${record.version}) is no longer archived`
    );
  if ((await outputDigest(directory)) !== record.outputDigest)
    throw new ChannelError('CHANNEL_ARCHIVE_CHANGED', 'archived bundle does not match its digest');
  return directory;
}

/**
 * Keeps every bundle the state points at, plus the newest few others.
 *
 * @param {string} dir @param {ChannelState} state
 */
export async function pruneBundles(dir, state) {
  const keep = new Set(
    [state.next?.build, state.production, ...state.previous]
      .filter(Boolean)
      .map(record => /** @type {BuildRecord} */ (record).outputDigest)
  );
  const root = path.join(dir, 'bundles');
  const entries = await readdir(root).catch(() => []);
  const others = [];
  for (const name of entries) {
    if (keep.has(name) || !HEX64.test(name)) continue;
    const info = await stat(path.join(root, name)).catch(() => null);
    if (info) others.push({ name, mtime: info.mtimeMs });
  }
  others.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of others.slice(EXTRA_BUNDLES))
    await rm(path.join(root, name), { recursive: true, force: true });
}

/**
 * @typedef {{
 *   outputDigest: string, indexDigest: string, manifestDigest: string,
 *   sourceSha: string|null, manifestSha?: string|null, version: string, buildId: string,
 *   deployedAt: string, kind: 'full'|'web-only'|'adopted'
 * }} BuildRecord
 * @typedef {{
 *   schemaVersion: 1,
 *   next: {status: 'testing'|'cancelled'|'promoted', build: BuildRecord, builds: number, startedAt: string} | null,
 *   production: BuildRecord | null,
 *   previous: BuildRecord[]
 * }} ChannelState
 */
