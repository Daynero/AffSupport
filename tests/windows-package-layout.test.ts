import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - build script without type declarations
import {
  isX64Executable,
  peMachine,
  PE_MACHINE_AMD64,
  REQUIRED_STAGE_ENTRIES,
  WHISPER_COMPANION_DLLS
} from '../scripts/lib/windows-package-layout.mjs';

/** Minimal PE image: DOS "MZ" stub, offset at 0x3c, "PE\0\0" and a machine word. */
function fakePe(machine: number, { signature = 'PE\0\0', peOffset = 0x80 } = {}): Buffer {
  const buffer = Buffer.alloc(0x100);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(peOffset, 0x3c);
  // A deliberately out-of-range offset leaves the signature/machine unwritten,
  // which is exactly the truncated-file case peMachine must reject.
  if (peOffset + 6 <= buffer.length) {
    buffer.write(signature, peOffset, 'ascii');
    buffer.writeUInt16LE(machine, peOffset + 4);
  }
  return buffer;
}

describe('PE inspection', () => {
  it('accepts a 64-bit Windows executable', () => {
    expect(isX64Executable(fakePe(PE_MACHINE_AMD64))).toBe(true);
  });

  it('rejects a 32-bit executable, which would install and then fail on first use', () => {
    const machine = peMachine(fakePe(0x014c)); // IMAGE_FILE_MACHINE_I386
    expect(machine.ok).toBe(true);
    expect(machine.value).not.toBe(PE_MACHINE_AMD64);
    expect(isX64Executable(fakePe(0x014c))).toBe(false);
  });

  it('rejects an ARM64 executable', () => {
    expect(isX64Executable(fakePe(0xaa64))).toBe(false);
  });

  it('names why a non-Windows file is not an executable', () => {
    const machine = peMachine(Buffer.from('#!/bin/sh\necho hello\n'.padEnd(0x100, ' ')));
    expect(machine.ok).toBe(false);
    expect(machine.error).toMatch(/MZ/u);
  });

  it('names a missing PE signature rather than reading a random word', () => {
    const machine = peMachine(fakePe(PE_MACHINE_AMD64, { signature: 'XX\0\0' }));
    expect(machine.ok).toBe(false);
    expect(machine.error).toMatch(/PE signature/u);
  });

  it('refuses a header offset pointing past the end of the file', () => {
    const machine = peMachine(fakePe(PE_MACHINE_AMD64, { peOffset: 0xfe }));
    expect(machine.ok).toBe(false);
  });

  it('refuses a file too small to be an executable', () => {
    expect(peMachine(Buffer.from('MZ')).ok).toBe(false);
  });

  it('identifies the real macOS-bundled node as NOT a Windows x64 binary', () => {
    // Guards against a Mach-O binary being staged into the Windows payload.
    const macNode = readFileSync('release/Soty.app/Contents/Resources/runtime/node');
    expect(isX64Executable(macNode)).toBe(false);
  });
});

describe('required stage layout', () => {
  const stagerSource = readFileSync('scripts/stage-windows-runtime.mjs', 'utf8');

  it('checks every binary the runtime stager copies into runtime/', () => {
    for (const entry of REQUIRED_STAGE_ENTRIES.filter((e: { path: string }) =>
      e.path.startsWith('runtime/')
    )) {
      expect(stagerSource, `${entry.path} must be produced by the stager`).toContain(entry.path);
    }
  });

  it('requires the agent, web and attribution payloads the installer ships', () => {
    const paths = REQUIRED_STAGE_ENTRIES.map((entry: { path: string }) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'agent/dist/index.js',
        'agent/node_modules',
        'agent/browser-runtime.json',
        'web/dist',
        'THIRD_PARTY_NOTICES.md',
        'release.json'
      ])
    );
  });

  it('PE-checks exactly the bundled Windows executables', () => {
    const executables = REQUIRED_STAGE_ENTRIES.filter(
      (entry: { x64Executable?: boolean }) => entry.x64Executable
    ).map((entry: { path: string }) => entry.path);
    expect(executables).toEqual([
      'runtime/node.exe',
      'runtime/bin/ffmpeg.exe',
      'runtime/bin/ffprobe.exe',
      'runtime/bin/whisper-cli.exe'
    ]);
  });

  it('knows whisper needs its shared libraries staged beside it', () => {
    // macOS bundles a statically linked whisper-cli; the official Windows build
    // is DLL-linked, so the .exe alone would fail with a missing-DLL dialog.
    expect(WHISPER_COMPANION_DLLS).toContain('whisper.dll');
    expect(stagerSource).toContain('WHISPER_LIBS_WIN');
  });
});
