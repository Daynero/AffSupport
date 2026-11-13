import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, lstat, statfs, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  NATIVE_UPDATE_LIMITS,
  isNativeUpdateDescriptor,
  nativeUpdateMatchesManifest,
  releaseManifestSigningPayload,
  updateRecord,
  type NativeUpdateDescriptor
} from '@video-compressor/shared';
import { AppUpdateError } from './coordinator.js';

async function boundedResponse(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new AppUpdateError('APP_UPDATE_DOWNLOAD_FAILED');
  const chunks: Buffer[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      length += chunk.length;
      if (length > maximum) throw new AppUpdateError('APP_UPDATE_INVALID');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function fetchNativeUpdateManifest(input: {
  url: string;
  publicKey: string;
  channel: string;
  target: string;
  signal: AbortSignal;
}): Promise<{ candidate: NativeUpdateDescriptor; payload: string; signature: string }> {
  const response = await fetch(input.url, {
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.any([
      input.signal,
      AbortSignal.timeout(NATIVE_UPDATE_LIMITS.requestTimeoutMs)
    ])
  });
  const bytes = await boundedResponse(response, NATIVE_UPDATE_LIMITS.manifestBytes);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AppUpdateError('APP_UPDATE_MANIFEST_INVALID');
  }
  if (
    !updateRecord(value) ||
    value.schemaVersion !== 1 ||
    value.channel !== input.channel ||
    typeof value.signature !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value.signature) ||
    !updateRecord(value.nativeUpdates)
  )
    throw new AppUpdateError('APP_UPDATE_MANIFEST_INVALID');
  const candidate = value.nativeUpdates[input.target];
  if (
    !isNativeUpdateDescriptor(candidate) ||
    typeof value.version !== 'string' ||
    typeof value.buildNumber !== 'string' ||
    typeof value.buildId !== 'string' ||
    !nativeUpdateMatchesManifest(candidate, {
      version: value.version,
      buildId: value.buildId,
      buildNumber: value.buildNumber,
      channel: input.channel
    })
  )
    throw new AppUpdateError('APP_UPDATE_MANIFEST_INVALID');
  const payload = Buffer.from(releaseManifestSigningPayload(value));
  if (payload.length > NATIVE_UPDATE_LIMITS.canonicalPayloadBytes)
    throw new AppUpdateError('APP_UPDATE_MANIFEST_INVALID');
  const key = createPublicKey({
    key: Buffer.from(input.publicKey, 'base64'),
    format: 'der',
    type: 'spki'
  });
  if (
    !verify(
      'sha256',
      payload,
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(value.signature, 'base64url')
    )
  )
    throw new AppUpdateError('APP_UPDATE_MANIFEST_INVALID');
  return { candidate, payload: payload.toString('base64'), signature: value.signature };
}

/** GitHub's signed artifact may redirect only to its own download CDN. */
async function archiveResponse(url: string, signal: AbortSignal): Promise<Response> {
  let current = new URL(url);
  const fixture = current.protocol === 'http:' && current.hostname === '127.0.0.1';
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(current, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const next = response.headers.get('location');
    await response.body?.cancel();
    if (!next || fixture) throw new AppUpdateError('APP_UPDATE_DOWNLOAD_FAILED');
    current = new URL(next, current);
    if (
      current.protocol !== 'https:' ||
      ![
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com'
      ].includes(current.hostname) ||
      current.username ||
      current.password ||
      (current.port && current.port !== '443')
    )
      throw new AppUpdateError('APP_UPDATE_DOWNLOAD_FAILED');
  }
  throw new AppUpdateError('APP_UPDATE_DOWNLOAD_FAILED');
}
export async function prepareNativeArchive(
  candidate: NativeUpdateDescriptor,
  directory: string,
  signal: AbortSignal,
  progress: (bytes: number) => void
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
    throw new AppUpdateError('APP_UPDATE_UNSAFE_INSTALLATION');
  const disk = await statfs(directory);
  if (
    disk.bavail * disk.bsize <
    candidate.archive.length * 3 + NATIVE_UPDATE_LIMITS.minimumFreeBytes
  )
    throw new AppUpdateError('APP_UPDATE_DISK_FULL');
  // One serialized producer owns this cache. Only digest-named regular files
  // are eligible for eviction; never follow or remove arbitrary paths.
  const entries = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.zip$/.test(name));
  const cached = await Promise.all(
    entries.map(async name => ({ name, info: await lstat(path.join(directory, name)) }))
  );
  const keep = candidate.archive.sha256 + '.zip';
  const others = cached
    .filter(entry => entry.name !== keep && entry.info.isFile() && !entry.info.isSymbolicLink())
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  for (const entry of others.slice(NATIVE_UPDATE_LIMITS.cacheEntries - 1))
    await unlink(path.join(directory, entry.name));
  for (const name of await readdir(directory))
    if (/^[a-f0-9]{64}\.zip\.[a-f0-9-]{36}\.tmp$/.test(name)) {
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (info.isFile() && !info.isSymbolicLink()) await unlink(file);
    }
  const destination = path.join(directory, `${candidate.archive.sha256}.zip`);
  // A cache hit is rehashed; a durable prepared flag is not evidence of cached bytes.
  try {
    const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await file.stat();
      if (s.isFile() && s.size === candidate.archive.length) {
        const hash = createHash('sha256');
        for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
        if (hash.digest('hex') === candidate.archive.sha256) {
          progress(s.size);
          return destination;
        }
      }
    } finally {
      await file.close();
    }
  } catch {
    /* A missing or invalid cache is downloaded again without trusting it. */
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const output = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  const hash = createHash('sha256');
  let size = 0;
  let reported = 0;
  try {
    const response = await archiveResponse(
      candidate.archive.url,
      AbortSignal.any([signal, AbortSignal.timeout(NATIVE_UPDATE_LIMITS.downloadTimeoutMs)])
    );
    if (!response.ok || !response.body) throw new AppUpdateError('APP_UPDATE_DOWNLOAD_FAILED');
    const expected = response.headers.get('content-length');
    if (expected !== null && Number(expected) !== candidate.archive.length) {
      await response.body.cancel();
      throw new AppUpdateError('APP_UPDATE_DIGEST_MISMATCH');
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new AppUpdateError('APP_UPDATE_INTERRUPTED');
        size += chunk.length;
        if (size > candidate.archive.length) throw new AppUpdateError('APP_UPDATE_DIGEST_MISMATCH');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await output.write(chunk, offset, chunk.length - offset);
          if (!written.bytesWritten) throw new AppUpdateError('APP_UPDATE_DISK_FULL');
          offset += written.bytesWritten;
        }
        if (Date.now() - reported >= 250) {
          progress(size);
          reported = Date.now();
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (size !== candidate.archive.length || hash.digest('hex') !== candidate.archive.sha256)
      throw new AppUpdateError('APP_UPDATE_DIGEST_MISMATCH');
    await output.sync();
    await output.close();
    await rename(temporary, destination);
    const parent = await open(directory, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    progress(size);
    return destination;
  } catch (error) {
    if (error instanceof AppUpdateError) throw error;
    if (signal.aborted) throw new AppUpdateError('APP_UPDATE_INTERRUPTED');
    throw new AppUpdateError(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'APP_UPDATE_DOWNLOAD_TIMEOUT'
        : 'APP_UPDATE_DOWNLOAD_FAILED'
    );
  } finally {
    await output.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export function nativeUpdateFeed(candidate: NativeUpdateDescriptor): string {
  const xml = (value: string) =>
    value.replace(
      /[<>&"']/g,
      c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c
    );
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Soty</title><item><sparkle:version>${xml(candidate.buildNumber)}</sparkle:version><sparkle:shortVersionString>${xml(candidate.version)}</sparkle:shortVersionString><sparkle:minimumSystemVersion>${xml(candidate.minimumSystemVersion)}</sparkle:minimumSystemVersion><enclosure url="${xml(candidate.archive.url)}" length="${candidate.archive.length}" type="application/octet-stream" sparkle:edSignature="${xml(candidate.archive.edSignature)}"/></item></channel></rss>`;
}
