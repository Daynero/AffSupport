#!/usr/bin/env node
/** Native boundary probe and bounded packaged-beta observation recorder.
 * This command does not infer acceptance from collected snapshots.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { renderNativeUpdatePolicy } from './lib/native-update-policy.mjs';
import { capture as runCapture } from './lib/native-update-capture.mjs';
const exec = promisify(execFile);
const capture = () => runCapture(process.argv.slice(2));
const args = process.argv.slice(2);
if (args.includes('--native-boundaries')) {
  if (process.platform !== 'darwin') throw new Error('NATIVE_PROBE_MACOS_REQUIRED');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-native-boundaries-'));
  try {
    const policy = path.join(directory, 'Policy.swift');
    await writeFile(
      policy,
      renderNativeUpdatePolicy(process.arch === 'x64' ? 'x64' : 'arm64', true)
    );
    const binary = path.join(directory, 'probe');
    await exec(
      '/usr/bin/nice',
      [
        '-n',
        '15',
        '/usr/bin/swiftc',
        '-j',
        '1',
        '-module-cache-path',
        process.env.SOTY_NATIVE_MODULE_CACHE ?? path.join(directory, 'module-cache'),
        'packaging/NativeUpdates/Models.swift',
        'packaging/NativeUpdates/ReceiptStore.swift',
        'packaging/NativeUpdates/Recovery.swift',
        'packaging/NativeUpdates/Readiness.swift',
        'packaging/NativeUpdates/FixtureProfile.swift',
        'packaging/NativeUpdates/Channel.swift',
        policy,
        'packaging/NativeUpdates/Tests/main.swift',
        '-o',
        binary
      ],
      { timeout: 120000 }
    );
    const { stdout } = await exec(binary, [], { timeout: 30000 });
    process.stdout.write(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} else if (args.includes('--capture')) {
  await capture();
} else {
  process.stdout.write(
    'Usage: --native-boundaries | --capture --scenario=<case> --output=<file> (--app=<running Soty Beta.app> | --launch=<Soty Beta.app>) [--pair] [--fault=<stage>] [--step=<stage|*>:<action>]... [--until=<stage>] [--settle-ms=<ms>] [--timeout-ms=<ms>]\n'
  );
}
