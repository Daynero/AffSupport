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

/**
 * What the tray host's own publish directory must contain.
 *
 * The installer copies that directory with a wildcard (`Source: "{#HostDir}\*"`),
 * so a missing or wrong-architecture host does not fail the compile — it
 * produces an installer that installs cleanly and then does nothing, with an
 * autostart entry pointing at a file that is not there. The one binary the whole
 * package exists to run has to be checked like the other four.
 */
export const REQUIRED_HOST_ENTRIES = [
  { path: 'SotyAgentHost.exe', x64Executable: true, minBytes: 10_000 }
];

/** Shared libraries the DLL-linked whisper.cpp Windows build needs beside it. */
export const WHISPER_COMPANION_DLLS = ['whisper.dll', 'ggml.dll', 'ggml-base.dll'];

/**
 * The Microsoft Visual C++ runtime the official whisper.cpp Windows build is linked
 * against (dynamic CRT and OpenMP). Windows 10/11 ship the Universal CRT
 * (`api-ms-win-crt-*`) but not these: on a machine where nothing installed the
 * Visual C++ Redistributable, whisper-cli.exe exited at once and every
 * transcription failed with TRANSCRIBE_FAILED (production 2026-11-12). They are
 * redistributable files, deployed app-locally beside the binaries that import them.
 */
export const MSVC_RUNTIME_DLLS = [
  'msvcp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'vcomp140.dll'
];

/**
 * Libraries a staged binary imports that are missing beside it, case-insensitively
 * (PE import names keep whatever case the linker wrote: `VCOMP140.DLL`).
 */
export function missingCompanionDlls(binaryText, presentNames, candidates) {
  const text = binaryText.toLowerCase();
  const present = new Set([...presentNames].map(name => name.toLowerCase()));
  return candidates.filter(
    dll => text.includes(dll.toLowerCase()) && !present.has(dll.toLowerCase())
  );
}

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
