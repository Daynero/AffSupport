// Layout rules and PE inspection for the staged Windows payload.
//
// Separate from scripts/verify-windows-package.mjs so the rules can be unit
// tested (including from macOS) without running the verifier's CLI entrypoint.

/**
 * Everything the installer must contain, mirroring the macOS bundle's
 * `Contents/Resources` layout so the agent's relative `../../../runtime`
 * lookups work unchanged.
 *
 * `x64Executable` entries additionally have their PE header inspected: a
 * 32-bit or non-Windows binary here would install fine and then fail on first
 * use, which is exactly the class of defect CI has to catch.
 */
export const REQUIRED_STAGE_ENTRIES = [
  { path: 'runtime/node.exe', x64Executable: true },
  { path: 'runtime/bin/ffmpeg.exe', x64Executable: true },
  { path: 'runtime/bin/ffprobe.exe', x64Executable: true },
  { path: 'runtime/bin/whisper-cli.exe', x64Executable: true },
  { path: 'runtime/models/ggml-silero-v5.1.2.bin', minBytes: 100_000 },
  { path: 'agent/dist/index.js' },
  { path: 'agent/package.json' },
  { path: 'agent/node_modules' },
  { path: 'agent/production-dependencies.json' },
  { path: 'agent/browser-runtime.json' },
  { path: 'web/dist' },
  { path: 'THIRD_PARTY_NOTICES.md' },
  { path: 'release.json' }
];

/** Shared libraries the DLL-linked whisper.cpp Windows build needs beside it. */
export const WHISPER_COMPANION_DLLS = ['whisper.dll', 'ggml.dll', 'ggml-base.dll'];

/** Release identity fields the staged release.json must reproduce exactly. */
export const RELEASE_IDENTITY_FIELDS = [
  'productVersion',
  'buildNumber',
  'buildId',
  'apiVersion',
  'channel',
  'tag'
];

export const PE_MACHINE_AMD64 = 0x8664;

/**
 * Machine type from a PE image, or a discriminated failure. A PE32+ image opens
 * with the "MZ" DOS stub; the offset at 0x3c points at the "PE\0\0" signature,
 * and the machine word follows it.
 */
export function peMachine(buffer) {
  if (buffer.length < 0x40) return { ok: false, error: 'file is too small to be an executable' };
  if (buffer.subarray(0, 2).toString('ascii') !== 'MZ') {
    return { ok: false, error: 'not a Windows executable (no MZ header)' };
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length) return { ok: false, error: 'PE header offset is out of range' };
  if (buffer.subarray(peOffset, peOffset + 4).toString('ascii') !== 'PE\0\0') {
    return { ok: false, error: 'no PE signature' };
  }
  return { ok: true, value: buffer.readUInt16LE(peOffset + 4) };
}

/** True when the buffer is a 64-bit Windows executable. */
export function isX64Executable(buffer) {
  const machine = peMachine(buffer);
  return machine.ok && machine.value === PE_MACHINE_AMD64;
}
