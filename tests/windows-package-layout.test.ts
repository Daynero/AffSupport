import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isX64Executable,
  peMachine,
  PE_MACHINE_AMD64,
  REQUIRED_HOST_ENTRIES,
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

  it('identifies a macOS Mach-O executable as NOT a Windows x64 binary', () => {
    // Hermetic guard against a Mach-O binary being staged into the Windows payload.
    const macNode = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
    expect(isX64Executable(macNode)).toBe(false);
  });
});

describe('required stage layout', () => {
  const stagerSource = readFileSync('scripts/stage-windows-runtime.mjs', 'utf8');
  const workflow = readFileSync('.github/workflows/release-windows.yml', 'utf8');

  it('installs the media tools used by the Ubuntu validation suite', () => {
    const validateJob = workflow.slice(workflow.indexOf('validate:'), workflow.indexOf('  build:'));
    expect(validateJob).toContain('ffmpeg');
    expect(validateJob).toContain('libarchive-tools');
  });

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

  it('PE-checks the tray host too, which the installer copies by wildcard', () => {
    // `Source: "{#HostDir}\\*"` copies whatever is there, so a missing or 32-bit
    // host compiles into a valid installer that installs an autostart entry
    // pointing at a file which is not present. Nothing else in the pipeline
    // looks at this binary.
    const host = REQUIRED_HOST_ENTRIES.map((entry: { path: string }) => entry.path);
    expect(host).toEqual(['SotyAgentHost.exe']);
    expect(
      REQUIRED_HOST_ENTRIES.every((entry: { x64Executable?: boolean }) => entry.x64Executable)
    ).toBe(true);

    const verifier = readFileSync('scripts/verify-windows-package.mjs', 'utf8');
    expect(verifier).toContain('VITE_SUPABASE_URL');
    expect(verifier).toContain('VITE_SUPABASE_PUBLISHABLE_KEY');
    expect(verifier).toContain('REQUIRED_HOST_ENTRIES');
    expect(workflow).toMatch(/verify-windows-package\.mjs[\s\S]{0,120}release\/windows\/host/u);
  });

  it('publishes a self-contained single-file host with no .NET prerequisite', () => {
    const publishStep = workflow.slice(
      workflow.indexOf('- name: Publish the tray host'),
      workflow.indexOf('- name: Render the installer script')
    );

    expect(publishStep).toContain('--self-contained true');
    expect(publishStep).toContain('/p:PublishSingleFile=true');
    expect(publishStep).not.toContain('--self-contained false');
  });

  it('knows whisper needs its shared libraries staged beside it', () => {
    // macOS bundles a statically linked whisper-cli; the official Windows build
    // is DLL-linked, so the .exe alone would fail with a missing-DLL dialog.
    expect(WHISPER_COMPANION_DLLS).toContain('whisper.dll');
    expect(stagerSource).toContain('WHISPER_LIBS_WIN');
  });
});
