import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Stand-in tools that behave badly on purpose.
 *
 * Six test files build one of these inline, each slightly different, and between them they
 * cover about half the misbehaviours that matter. The pattern in
 * `tests/stop-leaves-nothing-running.test.ts` is the most developed of them and this is its
 * promotion: one factory, every switch, and a written record of why each switch exists.
 *
 * All of them are **governed**: a test points `FFMPEG_PATH` or `WHISPER_PATH` at the path
 * this returns, so the agent spawns it through `power/spawn.ts` exactly as it spawns the
 * real encoder. Nothing here spawns anything on the agent's behalf, which is what keeps
 * `tests/power-spawn-coverage.test.ts` meaningful.
 *
 * **A warning about `burnCpu` and `grandchildren`.** Each burns one core in a tight loop
 * with no yielding, because the point is to give `tests/support/machine-probe.ts` something
 * real to measure. A test that asks for more of them than the machine has cores will make
 * the machine unusable for as long as it runs, and a leaked one will keep doing so after
 * the test ends. Keep the counts small and always stop what you start.
 */

export interface StubToolConfig {
  /**
   * Emit FFmpeg's `-progress pipe:1` dialect on stdout — `out_time_us=` lines and a final
   * `progress=end`. That is the exact dialect `ffmpeg/encoder.ts` parses, so a stub without
   * it exercises the spawn but never the progress path.
   */
  progress?: boolean;
  /** Wall-clock span the simulated work takes. Progress is spread evenly across it. */
  durationMs?: number;
  /** Media length the progress lines describe, so a percentage can be derived from them. */
  mediaSeconds?: number;
  /**
   * Consume a core rather than sleeping. Required whenever the assertion is about
   * consumption; pointless and expensive otherwise.
   */
  burnCpu?: boolean;
  /**
   * Install a SIGTERM handler that does nothing.
   *
   * Not a contrived case: a process wedged inside a native inference loop never reaches its
   * handler either, and from the outside the two are indistinguishable. Either way a stop
   * that only sends SIGTERM leaves the machine busy.
   */
  ignoreSigterm?: boolean;
  /** Never progress and never exit. For deadline and watchdog paths. */
  hang?: boolean;
  /** Exit code once the work completes. Non-zero drives the failure branches. */
  exitCode?: number;
  /** Written to stderr before exit — how the audio-copy fallback is triggered. */
  stderr?: string;
  /**
   * Text written to stdout before anything else.
   *
   * For standing in as a probe rather than an encoder: `probeDuration` spawns FFprobe and
   * reads a bare number from its output, so a stub that answers `12.5` is a file the
   * transcriber considers twelve and a half seconds long.
   */
  stdoutText?: string;
  /**
   * Bytes written to stdout verbatim, base64-encoded here.
   *
   * Some callers pipe an image out of the encoder rather than to a file — the landing
   * optimiser decodes a frame to PNG on `pipe:1` and parses it in process. Text with a
   * trailing newline is not a PNG, so those callers need real bytes.
   */
  stdoutBase64?: string;
  /**
   * Number of CPU-burning children this stub spawns and then **abandons**.
   *
   * The orphan case, and the reason the machine probe reads the whole process table rather
   * than the agent's own bookkeeping: a stop that terminates the direct child only, or that
   * loses track after a reparent, leaves these running and reports success.
   */
  grandchildren?: number;
  /**
   * How long an abandoned grandchild lives before it gives up, in milliseconds.
   *
   * A fuse, not a feature. Every assertion about a leak resolves within seconds, so two
   * minutes can never hide one — but a run that is killed mid-test would otherwise leave a
   * core pegged until the machine is rebooted.
   */
  grandchildFuseMs?: number;
  /**
   * How long a hanging stub burns before it stops, in milliseconds.
   *
   * The same fuse, for the stub itself. A `hang` + `burnCpu` stub is a process that consumes
   * a core and never exits on its own, and its parent is a test-runner fork that can be torn
   * down at any moment — a timeout, an interrupt, a crash. When that happens the stub is
   * reparented to init and keeps burning, which is a wedged machine rather than a failed
   * test. Observed here, not hypothesised.
   *
   * Two minutes is far longer than any assertion built on it, so it cannot mask a leak.
   */
  burnFuseMs?: number;
  /** Created on start, so a test can prove a spawn happened even if the child is killed. */
  spawnMarker?: string;
  /**
   * Per-invocation behaviour, for the paths that re-run the same tool.
   *
   * The compressor's audio-copy fallback is the reason this exists: it re-encodes after a
   * first attempt fails with a container-specific message, and a stub that behaves the same
   * way every time can only ever exercise one half of it. Attempt *n* uses entry *n*; runs
   * past the end of the list fall back to the top-level `exitCode` and `stderr`.
   *
   * Requires `attemptCounter`, since each run is a fresh process with no memory of the last.
   */
  attempts?: readonly { exitCode?: number; stderr?: string }[];
  /** File the stub uses to count its own invocations. Required by `attempts`. */
  attemptCounter?: string;
  /**
   * A JSON file read at startup whose fields override the baked-in configuration.
   *
   * For callers that need one installed tool to behave differently from one run to the next.
   * The agent reads `FFMPEG_PATH` into a module constant when it is first imported, so a
   * test cannot point it somewhere else per case without rebuilding the module graph; a file
   * the stub re-reads on every launch is how the same installed tool succeeds for one
   * transition and fails for the next.
   */
  behaviourFile?: string;
  /** Create the file named by the last argument, so callers see the artefact they expect. */
  writeOutput?: boolean;
}

/**
 * Writes an executable stub and returns the path to invoke it by.
 *
 * The body is CommonJS in a `.cjs` file so its module kind cannot be changed by whichever
 * `package.json` happens to sit above the directory it was written into.
 */
export async function writeStubTool(
  directory: string,
  name: string,
  config: StubToolConfig = {}
): Promise<string> {
  const bodyPath = path.join(directory, `${name}.cjs`);
  await writeFile(bodyPath, stubSource(config), 'utf8');

  if (process.platform !== 'win32') {
    // The shebang plus the execute bit is what lets the agent run it by path, the same way
    // it would run a real binary.
    await chmod(bodyPath, 0o755);
    return bodyPath;
  }

  // Windows has no shebang. A `.cmd` shim beside the body is what makes the same fixture
  // work on the platform the release actually has to pass on.
  const shimPath = path.join(directory, `${name}.cmd`);
  await writeFile(shimPath, `@echo off\r\nnode "%~dp0${name}.cjs" %*\r\n`, 'utf8');
  return shimPath;
}

function stubSource(config: StubToolConfig): string {
  const settings = {
    progress: config.progress ?? false,
    durationMs: config.durationMs ?? 1_000,
    mediaSeconds: config.mediaSeconds ?? 10,
    burnCpu: config.burnCpu ?? false,
    ignoreSigterm: config.ignoreSigterm ?? false,
    hang: config.hang ?? false,
    exitCode: config.exitCode ?? 0,
    stderr: config.stderr ?? '',
    stdoutText: config.stdoutText ?? '',
    stdoutBase64: config.stdoutBase64 ?? '',
    grandchildren: config.grandchildren ?? 0,
    grandchildFuseMs: config.grandchildFuseMs ?? 120_000,
    burnFuseMs: config.burnFuseMs ?? 120_000,
    spawnMarker: config.spawnMarker ?? '',
    writeOutput: config.writeOutput ?? false,
    attempts: config.attempts ?? [],
    attemptCounter: config.attemptCounter ?? '',
    behaviourFile: config.behaviourFile ?? ''
  };

  // Self-contained on purpose. A stub that `require`d a shared helper would resolve that
  // helper relative to a temporary directory, and the first test that copied its fixture
  // somewhere else would get a spawn failure instead of the behaviour it asked for.
  return `#!/usr/bin/env node
'use strict';
const CONFIG = ${JSON.stringify(settings, null, 2)};
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Re-read on every launch, so one installed tool can behave differently per run.
if (CONFIG.behaviourFile) {
  try {
    Object.assign(CONFIG, JSON.parse(fs.readFileSync(CONFIG.behaviourFile, 'utf8')));
  } catch {
    // No file yet, or mid-write: the baked-in configuration stands.
  }
}

// "Are you there?" is answered immediately, whatever else this stub is configured to do.
// The agent probes every tool with a version flag while it starts up, and a stand-in that
// hung on that probe would hang the launch — which looks nothing like the failure it was
// written to reproduce.
if (process.argv.slice(2).some(arg => arg === '-version' || arg === '--version')) {
  process.stdout.write('soty stub tool version 0\\n');
  process.exit(0);
}

if (CONFIG.spawnMarker) fs.writeFileSync(CONFIG.spawnMarker, String(process.pid));

// Which invocation is this? Counted on disk because every run is a fresh process, and the
// paths worth testing here are exactly the ones that run the same tool twice.
let attempt = 0;
if (CONFIG.attemptCounter) {
  try {
    attempt = Number(fs.readFileSync(CONFIG.attemptCounter, 'utf8')) || 0;
  } catch {
    attempt = 0;
  }
  fs.writeFileSync(CONFIG.attemptCounter, String(attempt + 1));
}
const thisAttempt = CONFIG.attempts[attempt] || {};
const exitCode = thisAttempt.exitCode === undefined ? CONFIG.exitCode : thisAttempt.exitCode;
const stderrText = thisAttempt.stderr === undefined ? CONFIG.stderr : thisAttempt.stderr;

// Swallowing SIGTERM must happen before anything announces readiness, or a signal that
// arrives first would be testing the default disposition instead of the handler.
if (CONFIG.ignoreSigterm) process.on('SIGTERM', () => {});

// Detached and unreferenced: these outlive this process on purpose, so a stop that only
// reaches the direct child leaves something for the machine probe to find.
for (let index = 0; index < CONFIG.grandchildren; index += 1) {
  const burn =
    'const until = Date.now() + ' + CONFIG.grandchildFuseMs + ';' +
    'while (Date.now() < until) Math.sqrt(Math.random());';
  const child = spawn(process.execPath, ['-e', burn], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

if (CONFIG.writeOutput) {
  const output = process.argv[process.argv.length - 1];
  // Not a flag, and not one of FFmpeg's pseudo-destinations. pipe:1 is stdout spelled as an
  // argument, and taking it literally created a file called pipe:1 in whatever directory the
  // run happened to start from.
  const target = output || '';
  const pseudo =
    target.startsWith('pipe:') || target === '-' || target.startsWith('/dev/');
  if (output && !output.startsWith('-') && !pseudo) {
    try {
      fs.writeFileSync(output, 'stub output');
    } catch {
      // A stub cannot know every caller's argument order; failing to guess it is not a
      // reason to fail the spawn the test is actually about.
    }
  }
}

if (CONFIG.stdoutBase64) process.stdout.write(Buffer.from(CONFIG.stdoutBase64, 'base64'));
if (CONFIG.stdoutText) process.stdout.write(CONFIG.stdoutText + '\\n');
if (stderrText) process.stderr.write(stderrText + '\\n');

// Announce readiness on stdout. A test that signals before this line is racing the process
// it is trying to interrupt.
//
// Suppressed when this stub is answering *on* stdout: a probe's caller parses everything it
// receives, and a readiness marker appended to a JSON document is a JSON document that no
// longer parses.
if (!CONFIG.stdoutText && !CONFIG.stdoutBase64) process.stdout.write('ready\\n');

const step = 50;

/** Burns one core in slices, yielding between them so signals are still delivered. */
function spin(next) {
  const until = Date.now() + step;
  while (Date.now() < until) Math.sqrt(Math.random());
  setImmediate(next);
}

if (CONFIG.hang) {
  // Referenced timer, so the event loop stays alive and this really does hang rather than
  // exiting quietly and looking like a fast success.
  setInterval(() => {}, 1000);
  // Composed with the hang path rather than exclusive to the timed one. A hanging stub that
  // consumed nothing made "the encoder is loading the machine" satisfiable by measurement
  // noise alone — so the assertion that consumption comes back down was proving nothing.
  if (CONFIG.burnCpu) {
    // Fused. This process has no natural end and its parent is a test-runner fork that can
    // vanish at any moment; without this it survives as an orphan burning a core.
    const stopAt = Date.now() + CONFIG.burnFuseMs;
    const forever = () => {
      if (Date.now() >= stopAt) process.exit(0);
      spin(forever);
    };
    forever();
  }
  return;
}

const startedAt = Date.now();

function emit(fraction) {
  if (!CONFIG.progress) return;
  const micros = Math.round(CONFIG.mediaSeconds * 1e6 * fraction);
  process.stdout.write('out_time_us=' + micros + '\\n');
}

function finish() {
  emit(1);
  if (CONFIG.progress) process.stdout.write('progress=end\\n');
  process.exit(exitCode);
}

function tick() {
  const elapsed = Date.now() - startedAt;
  if (elapsed >= CONFIG.durationMs) {
    finish();
    return;
  }
  emit(elapsed / CONFIG.durationMs);
  if (CONFIG.burnCpu) {
    // Busy-wait one slice of one core. Sleeping would consume nothing and every assertion
    // about consumption would pass against a tool that never worked.
    spin(tick);
  } else {
    setTimeout(tick, step);
  }
}

tick();
`;
}
