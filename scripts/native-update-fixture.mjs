#!/usr/bin/env node
// Isolated beta feed: fixed loopback routes, separate beta key, no production writes.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isNativeUpdateDescriptor } from '../packages/shared/dist/native-app-updates.js';
import { releaseManifestSigningPayload } from '../packages/shared/dist/release.js';
const option = name =>
  process.argv
    .slice(2)
    .find(value => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const descriptorFile = option('descriptor');
const port = Number(option('port') ?? 43141);
if (
  !descriptorFile?.endsWith('.native-update.json') ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  [43123, 43130, 43140, 5173, 5175].includes(port)
)
  throw new Error('NATIVE_FIXTURE_ARGUMENTS');
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
const manifest = {
  schemaVersion: 1,
  channel: 'beta',
  version: candidate.version,
  buildNumber: candidate.buildNumber,
  buildId: candidate.buildId,
  publishedAt: new Date().toISOString(),
  nativeUpdates: { [candidate.target]: candidate },
  signature: ''
};
manifest.signature = sign('sha256', Buffer.from(releaseManifestSigningPayload(manifest)), {
  key,
  dsaEncoding: 'ieee-p1363'
}).toString('base64url');
const bytes = Buffer.from(JSON.stringify(manifest));
const server = http.createServer((request, response) => {
  response.setHeader('cache-control', 'no-store');
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(405);
    response.end();
    return;
  }
  if (request.url === '/stable.json') {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
    return;
  }
  if (request.url !== new URL(candidate.archive.url).pathname) {
    response.writeHead(404);
    response.end();
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
    return;
  }
  const stream = createReadStream(archive, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
});
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(
    `Beta native fixture serving ${candidate.target} ${candidate.buildId} on loopback port ${port}.\n`
  )
);
