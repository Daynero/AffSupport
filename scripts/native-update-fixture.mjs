#!/usr/bin/env node
// Isolated beta feed: fixed loopback routes, separate beta key, no production writes.
//
// Qualification faults (052 deferred qualification). Every fault is opt-in and
// only changes what this loopback process serves; nothing reaches production:
//   --descriptor=<file>       repeatable; every archive is verified and profile-matched
//   --select=<file>           optional; holds the 0-based index of the descriptor to
//                             serve, re-read on every request (switch B→C without restart)
//   --fault=manifest-signature        stable.json with an invalid P-256 signature
//   --fault=archive-digest            archive bytes with one byte inverted, same length
//   --fault=archive-digest-after=<n>  the first n complete archive responses are genuine,
//                                     every later one is tampered (Sparkle's own download)
//   --fault=publisher=<TEAMID>        a validly re-signed manifest naming another publisher
//   --fault=target=<macos-arm64|macos-x64>  the candidate offered under another target key
//   --fault-file=<file>       optional; the fault applies only while this file exists
//   --log=<file>              optional; one JSON line per request (no secrets, no bodies)
//   --stop-file=<file>        optional; the server exits once this file exists
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isNativeUpdateDescriptor } from '../packages/shared/dist/native-app-updates.js';
import { releaseManifestSigningPayload } from '../packages/shared/dist/release.js';
import { readArchiveBetaUpdateProfile } from './lib/native-update-profile.mjs';
const argv = process.argv.slice(2);
const option = name => argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const options = name =>
  argv.filter(value => value.startsWith(`--${name}=`)).map(value => value.slice(name.length + 3));
const descriptorFiles = options('descriptor');
const port = Number(option('port') ?? 43141);
if (
  !descriptorFiles.length ||
  descriptorFiles.some(file => !file.endsWith('.native-update.json')) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  [43123, 43130, 43140, 5173, 5175].includes(port)
)
  throw new Error('NATIVE_FIXTURE_ARGUMENTS');
const fault = option('fault');
const faultMatch =
  fault === undefined
    ? null
    : /^(manifest-signature|archive-digest)$|^archive-digest-after=(\d{1,4})$|^publisher=([A-Z0-9]{10})$|^target=(macos-arm64|macos-x64)$/u.exec(
        fault
      );
if (fault !== undefined && !faultMatch) throw new Error('NATIVE_FIXTURE_FAULT_INVALID');
const faultFile = option('fault-file');
const selectFile = option('select');
const logFile = option('log');
const stopFile = option('stop-file');
const candidates = [];
for (const descriptorFile of descriptorFiles) {
  const candidate = JSON.parse(await readFile(descriptorFile, 'utf8'));
  if (
    !isNativeUpdateDescriptor(candidate) ||
    candidate.channel !== 'beta' ||
    new URL(candidate.archive.url).origin !== `http://127.0.0.1:${port}`
  )
    throw new Error('NATIVE_FIXTURE_DESCRIPTOR_INVALID');
  const archive = descriptorFile.slice(0, -'.native-update.json'.length);
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== candidate.archive.length)
    throw new Error('NATIVE_FIXTURE_ARCHIVE_INVALID');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== candidate.archive.sha256)
    throw new Error('NATIVE_FIXTURE_ARCHIVE_DIGEST');
  // A/B/C must share the sealed namespace, including after Sparkle relaunches.
  // Read the exact archive already matched above, never an adjacent mutable .app.
  const profile = readArchiveBetaUpdateProfile(
    archive,
    option('profile'),
    `http://127.0.0.1:${port}`
  );
  if (
    candidates.some(
      entry =>
        new URL(entry.candidate.archive.url).pathname === new URL(candidate.archive.url).pathname
    )
  )
    throw new Error('NATIVE_FIXTURE_DESCRIPTOR_DUPLICATE');
  candidates.push({ candidate, archive, info, profile });
}
const selected = () => {
  if (!selectFile) return 0;
  let raw;
  try {
    raw = readFileSync(selectFile, 'utf8').trim();
  } catch {
    return 0;
  }
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length)
    throw new Error('NATIVE_FIXTURE_SELECTION_INVALID');
  return index;
};
const faultActive = () => faultMatch !== null && (!faultFile || existsSync(faultFile));
const log = entry => {
  if (logFile) appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
};
const pins = JSON.parse(await readFile('config/native-updates.json', 'utf8'));
const keyFile = path.join(
  os.homedir(),
  'Library/Application Support/Soty/signing/updater-beta-manifest.private.pem'
);
const keyInfo = await lstat(keyFile);
if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || keyInfo.mode & 0o077)
  throw new Error('NATIVE_FIXTURE_KEY_PERMISSIONS');
const key = createPrivateKey(await readFile(keyFile));
if (
  createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') !==
  pins.beta.manifestPublicKey
)
  throw new Error('NATIVE_FIXTURE_KEY_PIN_MISMATCH');
const manifestBytes = (index, faulted) => {
  let candidate = candidates[index].candidate;
  let target = candidate.target;
  if (faulted && faultMatch?.[3]) candidate = { ...candidate, publisherTeamId: faultMatch[3] };
  if (faulted && faultMatch?.[4]) target = faultMatch[4];
  const manifest = {
    schemaVersion: 1,
    channel: 'beta',
    version: candidate.version,
    buildNumber: candidate.buildNumber,
    buildId: candidate.buildId,
    publishedAt: new Date().toISOString(),
    nativeUpdates: { [target]: candidate },
    signature: ''
  };
  manifest.signature = sign('sha256', Buffer.from(releaseManifestSigningPayload(manifest)), {
    key,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  if (faulted && faultMatch?.[1] === 'manifest-signature') {
    // Same length and alphabet, one decoded byte changed: the signature no longer verifies.
    // (The final base64url character also carries padding bits a decoder ignores, so the
    // change is made to the decoded bytes, never to that character.)
    const bytes = Buffer.from(manifest.signature, 'base64url');
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    manifest.signature = bytes.toString('base64url');
  }
  return Buffer.from(JSON.stringify(manifest));
};
let completeArchiveResponses = 0;
/** One inverted byte in the middle of the archive; length and range semantics unchanged. */
const tamper = (offset, middle) =>
  new Transform({
    transform(chunk, _encoding, done) {
      let position = offset;
      offset += chunk.length;
      if (middle >= position && middle < offset) {
        const copy = Buffer.from(chunk);
        copy[middle - position] ^= 0xff;
        done(null, copy);
      } else done(null, chunk);
    }
  });
const server = http.createServer((request, response) => {
  response.setHeader('cache-control', 'no-store');
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(405);
    response.end();
    log({ method: request.method, path: request.url, status: 405 });
    return;
  }
  const index = selected();
  const faulted = faultActive();
  if (request.url === '/stable.json') {
    const bytes = manifestBytes(index, faulted);
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
    log({
      method: request.method,
      path: '/stable.json',
      status: 200,
      index,
      fault: faulted ? fault : null
    });
    return;
  }
  const entry = candidates[index];
  const { candidate, archive, info } = entry;
  if (request.url !== new URL(candidate.archive.url).pathname) {
    response.writeHead(404);
    response.end();
    log({ method: request.method, path: request.url, status: 404, index });
    return;
  }
  let start = 0;
  let end = info.size - 1;
  if (request.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range);
    if (!match) {
      response.writeHead(416);
      response.end();
      return;
    }
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : end;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start < 0 ||
      end >= info.size
    ) {
      response.writeHead(416);
      response.end();
      return;
    }
    response.setHeader('content-range', `bytes ${start}-${end}/${info.size}`);
  }
  response.writeHead(request.headers.range ? 206 : 200, {
    'content-type': 'application/zip',
    'content-length': end - start + 1,
    'accept-ranges': 'bytes'
  });
  if (request.method === 'HEAD') {
    response.end();
    log({ method: 'HEAD', path: request.url, status: request.headers.range ? 206 : 200, index });
    return;
  }
  const whole = start === 0 && end === info.size - 1;
  const ordinal = whole ? ++completeArchiveResponses : null;
  const corrupt =
    faulted &&
    (faultMatch?.[1] === 'archive-digest' ||
      (faultMatch?.[2] !== undefined && (ordinal ?? Infinity) > Number(faultMatch[2])));
  const stream = createReadStream(archive, { start, end });
  let sent = 0;
  stream.on('data', chunk => {
    sent += chunk.length;
  });
  stream.on('error', () => response.destroy());
  response.on('close', () => {
    stream.destroy();
    log({
      method: 'GET',
      path: request.url,
      status: request.headers.range ? 206 : 200,
      index,
      range: request.headers.range ?? null,
      ordinal,
      tampered: Boolean(corrupt),
      bytes: sent,
      complete: response.writableFinished
    });
  });
  if (corrupt) stream.pipe(tamper(start, Math.floor(info.size / 2))).pipe(response);
  else stream.pipe(response);
});
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(
    `Beta native fixture serving ${candidates
      .map(({ candidate }) => `${candidate.target} ${candidate.buildId}`)
      .join(', ')} on loopback port ${port}; profile ${candidates[0].profile.profileId}${
      fault ? `; fault ${fault}${faultFile ? ' (while the fault file exists)' : ''}` : ''
    }.\n`
  )
);
if (stopFile) {
  const stopWatch = setInterval(() => {
    if (!existsSync(stopFile)) return;
    clearInterval(stopWatch);
    server.close();
    server.closeAllConnections();
    process.stdout.write('Beta native fixture stopped (stop file present).\n');
  }, 500);
}
