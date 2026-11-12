// Sign the already notarized/stapled archive, never rebuild or change its bytes.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { withSparkle } from './lib/native-update-sdk.mjs';
import {
  isNativeUpdateDescriptor,
  RELEASE_ARTIFACT_ORIGIN,
  RELEASE_ARTIFACT_PATH_PREFIX
} from '../packages/shared/dist/index.js';
const [archive, app, target, channel = 'stable'] = process.argv.slice(2);
if (
  !archive ||
  !app?.endsWith('.app') ||
  !['macos-arm64', 'macos-x64'].includes(target ?? '') ||
  !['stable', 'beta'].includes(channel)
)
  throw new Error('NATIVE_UPDATE_SIGN_ARGUMENTS');
const exec = promisify(execFile);
const profile = JSON.parse(
  await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8')
);
const version = profile.productVersion;
if (
  typeof version !== 'string' ||
  typeof profile.buildNumber !== 'string' ||
  profile.buildId !== `${version}+${profile.buildNumber}`
)
  throw new Error('NATIVE_UPDATE_PACKAGE_IDENTITY');
const signing = JSON.parse(await readFile(path.join(path.dirname(app), 'signing.json'), 'utf8'));
if (signing.identity !== 'developer-id' || !signing.notarized || !signing.stapled)
  throw new Error('NATIVE_UPDATE_APPLE_TRUST_REQUIRED');
const pins = JSON.parse(await readFile('config/native-updates.json', 'utf8'));
const key =
  process.env.SOTY_UPDATER_KEY_PATH ??
  path.join(os.homedir(), `Library/Application Support/Soty/signing/updater-${channel}.seed`);
const info = await lstat(key);
if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
  throw new Error('NATIVE_UPDATE_KEY_PERMISSIONS');
// The key must also match the public half embedded in BOTH the old and new host.
if (info.size > 128) throw new Error('NATIVE_UPDATE_KEY_INVALID');
const encodedSeed = (await readFile(key, 'utf8')).trim();
if (!/^[A-Za-z0-9+/]{43}=$/u.test(encodedSeed)) throw new Error('NATIVE_UPDATE_KEY_INVALID');
const seed = Buffer.from(encodedSeed, 'base64');
if (seed.length !== 32) throw new Error('NATIVE_UPDATE_KEY_INVALID');
const { createPrivateKey, createPublicKey } = await import('node:crypto');
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  type: 'pkcs8',
  format: 'der'
});
const publicX = createPublicKey(privateKey).export({ format: 'jwk' }).x;
if (
  typeof publicX !== 'string' ||
  Buffer.from(publicX, 'base64url').toString('base64') !== pins[channel].publicKey
)
  throw new Error('NATIVE_UPDATE_KEY_PIN_MISMATCH');
const signature = await withSparkle(async sdk => {
  const tool = path.join(sdk, 'bin/sign_update');
  const { stdout } = await exec(tool, ['--ed-key-file', key, '-p', archive], { timeout: 120000 });
  const value = stdout.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(value)) throw new Error('NATIVE_UPDATE_SIGNATURE_INVALID');
  await exec(tool, ['--ed-key-file', key, '--verify', archive, value], { timeout: 120000 });
  return value;
});
const hash = createHash('sha256');
for await (const bytes of createReadStream(archive)) hash.update(bytes);
const arch = target === 'macos-arm64' ? 'arm64' : 'x64';
const origin =
  channel === 'stable'
    ? RELEASE_ARTIFACT_ORIGIN + RELEASE_ARTIFACT_PATH_PREFIX.replace(/\/$/u, '')
    : process.env.SOTY_UPDATE_FIXTURE_ORIGIN;
const minimums = ['13.0'];
for (const name of ['node', 'bin/ffmpeg', 'bin/ffprobe', 'bin/whisper-cli']) {
  const { stdout } = await exec('/usr/bin/otool', [
    '-arch',
    arch === 'arm64' ? 'arm64' : 'x86_64',
    '-l',
    path.join(app, 'Contents/Resources/runtime', name)
  ]);
  for (const match of stdout.matchAll(
    /cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b(?:(?!\nLoad command)[\s\S])*?\b(?:minos|version) (\d+\.\d+(?:\.\d+)?)/gu
  ))
    minimums.push(match[1]);
}
const minimumSystemVersion = minimums
  .sort((a, b) => {
    const x = a.split('.').map(Number),
      y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  })
  .at(-1);
const candidate = {
  schemaVersion: 1,
  channel,
  target,
  version,
  buildNumber: profile.buildNumber,
  buildId: profile.buildId,
  sourceRevision: profile.sourceRevision,
  minimumSystemVersion,
  publisherTeamId: signing.teamId,
  archive: {
    url: `${origin}/v${version}/Soty-v${version}-macOS-${arch}.zip`,
    length: (await lstat(archive)).size,
    sha256: hash.digest('hex'),
    edSignature: signature
  }
};
if (!isNativeUpdateDescriptor(candidate)) throw new Error('NATIVE_UPDATE_DESCRIPTOR_INVALID');
await writeFile(`${archive}.native-update.json`, JSON.stringify(candidate, null, 2) + '\n', {
  flag: 'wx'
});
process.stdout.write(`Native update descriptor sealed (${target}).\n`);
