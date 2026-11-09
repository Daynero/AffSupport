#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  chmod,
  lstat
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { macosTarget, parseMacosTarget } from './lib/macos-target.mjs';
import { verifyMacosPayload, isMachOFile } from './lib/macos-payload.mjs';

const FILES = {
  node: 'runtime/node',
  ffmpeg: 'runtime/bin/ffmpeg',
  ffprobe: 'runtime/bin/ffprobe',
  whisper: 'runtime/bin/whisper-cli',
  vad: 'runtime/models/ggml-silero-v5.1.2.bin',
  ffmpegSource: 'licenses/sources/ffmpeg-source.tar.xz',
  x264Source: 'licenses/sources/x264-source.tar.gz'
};
const BINARIES = new Set(['node', 'ffmpeg', 'ffprobe', 'whisper']);
const digest = file =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });

/** Explicit approved local inputs only; no downloads, auth flags, app build or production gate. */
export async function stageMacosInputs({ cwd, arch, manifest }) {
  const target = macosTarget(arch);
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.architecture !== target.arch ||
    typeof manifest.cpuBaseline !== 'string' ||
    !/^[a-zA-Z0-9_.+-]{1,64}$/u.test(manifest.cpuBaseline) ||
    !manifest.files ||
    typeof manifest.files !== 'object'
  )
    throw new Error('MACOS_INPUT_MANIFEST_INVALID');
  const verified = [];
  for (const [key, relative] of Object.entries(FILES)) {
    const input = manifest.files[key];
    if (
      !input ||
      typeof input.path !== 'string' ||
      !path.isAbsolute(input.path) ||
      !/^[a-f0-9]{64}$/u.test(input.sha256 ?? '') ||
      typeof input.version !== 'string' ||
      !/^[a-zA-Z0-9_.+-]{1,96}$/u.test(input.version) ||
      typeof input.license !== 'string' ||
      !/^[a-zA-Z0-9_.+-]{1,96}$/u.test(input.license)
    )
      throw new Error(`MACOS_INPUT_INVALID: ${key}`);
    let source;
    try {
      source = new URL(input.source);
    } catch {
      throw new Error(`MACOS_INPUT_SOURCE_INVALID: ${key}`);
    }
    if (
      source.href.length > 2048 ||
      source.protocol !== 'https:' ||
      source.username ||
      source.password ||
      source.search ||
      source.hash
    )
      throw new Error(`MACOS_INPUT_SOURCE_INVALID: ${key}`);
    const info = await stat(input.path);
    if (!info.isFile() || info.size === 0 || (await digest(input.path)) !== input.sha256)
      throw new Error(`MACOS_INPUT_DIGEST_MISMATCH: ${key}`);
    verified.push({ ...input, key, relative });
  }
  const parent = path.join(cwd, 'release', 'inputs');
  const destination = path.join(parent, target.arch);
  if (await lstat(destination).catch(() => null)) throw new Error('MACOS_INPUT_DESTINATION_EXISTS');
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, `.${target.arch}-`));
  try {
    const resources = path.join(temporary, 'Contents', 'Resources');
    for (const input of verified) {
      const output = path.join(resources, input.relative);
      await mkdir(path.dirname(output), { recursive: true });
      await cp(input.path, output, { dereference: true });
      if ((await digest(output)) !== input.sha256)
        throw new Error(`MACOS_INPUT_DIGEST_MISMATCH: ${input.key}`);
      if (BINARIES.has(input.key)) {
        if (!(await isMachOFile(output)))
          throw new Error(`MACOS_INPUT_NATIVE_INVALID: ${input.key}`);
        await chmod(output, 0o755);
      }
    }
    await verifyMacosPayload(temporary, target.arch);
    await writeFile(
      path.join(temporary, 'approved-inputs.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          target: target.platform,
          cpuBaseline: manifest.cpuBaseline,
          // Local source paths never enter the reusable provenance artifact.
          files: verified.map(input => ({
            key: input.key,
            sha256: input.sha256,
            version: input.version,
            source: input.source,
            license: input.license
          }))
        },
        null,
        2
      ) + '\n'
    );
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** @param {Record<string, string | undefined>} [bindings] */
export async function verifyMacosInputs(root, arch, bindings) {
  const target = macosTarget(arch);
  const metadata = JSON.parse(await readFile(path.join(root, 'approved-inputs.json'), 'utf8'));
  if (
    metadata.schemaVersion !== 1 ||
    metadata.target !== target.platform ||
    !Array.isArray(metadata.files) ||
    metadata.files.length !== Object.keys(FILES).length ||
    new Set(metadata.files.map(file => file.key)).size !== Object.keys(FILES).length
  )
    throw new Error('MACOS_INPUT_PROVENANCE_INVALID');
  for (const [key, relative] of Object.entries(FILES)) {
    const input = metadata.files.find(file => file.key === key);
    if (
      !input ||
      !/^[a-f0-9]{64}$/u.test(input.sha256 ?? '') ||
      (await digest(path.join(root, 'Contents', 'Resources', relative))) !== input.sha256
    )
      throw new Error(`MACOS_INPUT_DIGEST_MISMATCH: ${key}`);
  }
  if (bindings)
    for (const [key] of Object.entries(FILES)) {
      const supplied = bindings[key];
      const expected = metadata.files.find(file => file.key === key)?.sha256;
      if (!supplied || (await digest(supplied)) !== expected)
        throw new Error(`MACOS_INPUT_BINDING_MISMATCH: ${key}`);
    }
  for (const key of BINARIES)
    if (!(await isMachOFile(path.join(root, 'Contents/Resources', FILES[key]))))
      throw new Error(`MACOS_INPUT_NATIVE_INVALID: ${key}`);
  return verifyMacosPayload(root, arch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const inputFlags = args.filter(arg => arg.startsWith('--inputs='));
  const verifyFlags = args.filter(arg => arg.startsWith('--verify='));
  if (inputFlags.length + verifyFlags.length !== 1)
    throw new Error(
      'MACOS_INPUT_MANIFEST_REQUIRED: --inputs=/absolute/path.json or --verify=/absolute/runtime'
    );
  const target = parseMacosTarget(
    args.filter(
      arg => !arg.startsWith('--inputs=') && !arg.startsWith('--verify=') && arg !== '--bind-env'
    )
  );
  if (verifyFlags.length) {
    const root = verifyFlags[0].slice(9);
    if (!path.isAbsolute(root)) throw new Error('MACOS_INPUT_MANIFEST_PATH_INVALID');
    const bindings = args.includes('--bind-env')
      ? Object.fromEntries(
          Object.entries({
            node: 'NODE_BINARY',
            ffmpeg: 'FFMPEG_BINARY',
            ffprobe: 'FFPROBE_BINARY',
            whisper: 'WHISPER_BINARY',
            vad: 'WHISPER_VAD_MODEL',
            ffmpegSource: 'FFMPEG_SOURCE_ARCHIVE',
            x264Source: 'X264_SOURCE_ARCHIVE'
          }).map(([key, envKey]) => [key, process.env[envKey]])
        )
      : undefined;
    process.stdout.write(
      `${JSON.stringify(await verifyMacosInputs(root, target.arch, bindings))}\n`
    );
  } else {
    if (args.includes('--bind-env')) throw new Error('MACOS_INPUT_BINDING_MODE_INVALID');
    const manifestPath = inputFlags[0].slice(9);
    if (!path.isAbsolute(manifestPath)) throw new Error('MACOS_INPUT_MANIFEST_PATH_INVALID');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const destination = await stageMacosInputs({ cwd: process.cwd(), arch: target.arch, manifest });
    process.stdout.write(
      `Staged target-compatible local runtime at ${destination}. Physical execution is still unverified.\n`
    );
  }
}
