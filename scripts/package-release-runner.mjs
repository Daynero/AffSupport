#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * The minimum macOS the helper is pinned to. Building against the host SDK's
 * newest target would produce a probe that refuses to start on the older
 * machines this release runner exists to be gentle with.
 */
const PROBE_TARGET = 'arm64-apple-macos13';

async function digest(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/**
 * Compiles the helper once, at runner installation.
 *
 * This is deliberately the only place a compiler is invoked for the probe. A
 * release that could build its own probe could also build a different one, and
 * the digest recorded here is what preflight later insists on.
 */
export async function buildResourceProbe({ sourcePath, outputPath }) {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(outputPath))
    throw new Error('PROBE_BUILD_PATH_INVALID');
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await exec('swiftc', ['-O', '-target', PROBE_TARGET, '-o', outputPath, sourcePath], {
    shell: false
  });
  await chmod(outputPath, 0o755);
  return Object.freeze({
    executable: outputPath,
    target: PROBE_TARGET,
    digest: await digest(outputPath)
  });
}

/** Provision an already-built helper; intentionally has no compiler fallback. */
export async function provisionResourceProbe({ probePath, destination, sourcePath }) {
  if (!path.isAbsolute(probePath) || !path.isAbsolute(destination) || !path.isAbsolute(sourcePath))
    throw new Error('PROBE_PROVISION_PATH_INVALID');
  const target = path.join(destination, 'ResourceProbe');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await copyFile(probePath, target);
  await chmod(target, 0o755);
  const manifest = Object.freeze({
    version: 1,
    executable: target,
    target: PROBE_TARGET,
    digest: await digest(target),
    sourceDigest: await digest(sourcePath)
  });
  await writeFile(
    path.join(destination, 'ResourceProbe.provenance.json'),
    JSON.stringify(manifest),
    { mode: 0o600 }
  );
  return manifest;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [first, second] = process.argv.slice(2);
  const sourcePath = path.resolve('packaging/release/ResourceProbe.swift');
  // `--build <destination>` is the ordinary installation path; passing an
  // already-built probe stays supported so a signed helper can be provisioned
  // on a machine without a toolchain.
  const destination = path.resolve(first === '--build' ? second : second);
  if (!first || !second)
    throw new Error(
      'Usage: package-release-runner (--build | <prebuilt-probe>) <installation-destination>'
    );
  const probePath =
    first === '--build'
      ? (
          await buildResourceProbe({
            sourcePath,
            outputPath: path.join(destination, 'ResourceProbe.built')
          })
        ).executable
      : path.resolve(first);
  process.stdout.write(
    `${JSON.stringify(await provisionResourceProbe({ probePath, destination, sourcePath }))}\n`
  );
}
