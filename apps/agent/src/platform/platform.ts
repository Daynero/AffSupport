import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractZipSafely, writeZipDirectory } from './zip.js';
import { WindowsSuspendHelper } from './windows-suspend.js';

/**
 * Platform layer: every OS-specific mechanism the agent relies on lives behind
 * these pure functions so the rest of the codebase stays portable. On macOS the
 * behavior is exactly what the agent always did; win32/linux branches exist so
 * a port only has to touch this module.
 *
 * This is now enforced, not just intended: the `no-restricted-syntax` rule in
 * eslint.config.mjs rejects `process.platform`/`process.arch` anywhere under
 * apps/agent/src except this module and files/picker.ts (the native-dialog
 * implementation). Add a helper or a capability flag here rather than a branch
 * in a tool — a tool is written once and must run on both platforms.
 */

/** Feature switches for behavior that only some platforms can offer. */
export interface PlatformCapabilities {
  /** Native OS file/folder pickers (osascript on macOS). */
  nativeFilePicker: boolean;
  /** Scoped native directory intake routes; enabled when their module is registered. */
  directoryIntake: boolean;
  /** "Reveal in Finder/Explorer" style actions. */
  revealInFileManager: boolean;
  /** A file index the agent can ask by name (Spotlight on macOS, Windows Search on Windows). */
  indexedFileSearch: boolean;
  /**
   * File-manager context-menu integration that calls back into the agent (the
   * macOS Finder Sync extension and image-conversion Services provider, which
   * drive `/native/media-actions/*`). A Windows counterpart would be an Explorer
   * shell extension and is deliberately not shipped.
   */
  shellContextMenuIntegration: boolean;
  /**
   * Suspending and resuming a running child process. POSIX uses SIGSTOP/SIGCONT;
   * Windows has neither, and goes through a resident PowerShell helper that
   * calls NtSuspendProcess/NtResumeProcess (platform/windows-suspend.ts).
   */
  processPause: boolean;
}

export function capabilities(): PlatformCapabilities {
  switch (process.platform) {
    case 'darwin':
      return {
        nativeFilePicker: true,
        directoryIntake: true,
        revealInFileManager: true,
        indexedFileSearch: true,
        shellContextMenuIntegration: true,
        processPause: true
      };
    case 'win32':
      // Pickers are PowerShell WinForms dialogs (files/picker.ts).
      return {
        nativeFilePicker: true,
        directoryIntake: true,
        revealInFileManager: true,
        // Windows Search, through PowerShell (indexedFileSearch below).
        indexedFileSearch: true,
        shellContextMenuIntegration: false,
        // Real since the power throttle: NtSuspendProcess through a resident
        // PowerShell helper. Before that this was false and every suspend was a
        // silent no-op here.
        processPause: true
      };
    default:
      return {
        nativeFilePicker: false,
        directoryIntake: false,
        revealInFileManager: true,
        indexedFileSearch: false,
        shellContextMenuIntegration: false,
        processPause: true
      };
  }
}

/**
 * Base directory for per-user application data: macOS Application Support,
 * Windows Roaming AppData, and the XDG data home elsewhere.
 */
export function appSupportRoot(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support');
    case 'win32':
      return process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
    default:
      return path.join(os.homedir(), '.local', 'share');
  }
}

/** Appends the platform executable suffix (`.exe` on Windows). */
export function executableName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/**
 * The host platform/arch pair, for descriptor lookups and diagnostics. Exposed
 * here so callers never read `process.platform` directly — this module is the
 * only place allowed to (enforced by the `no-restricted-syntax` rule in
 * eslint.config.mjs).
 */
export function currentPlatform(): NodeJS.Platform {
  return process.platform;
}

/**
 * The host operating system in the vocabulary `/health` reports it in (031 FR-053), from the
 * same source the boot diagnostics record. `undefined` on any other host, so the field is
 * simply absent there rather than a guess.
 */
export function hostPlatform(): 'macos' | 'windows' | 'linux' | undefined {
  switch (currentPlatform()) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return undefined;
  }
}

export function currentArch(): string {
  return process.arch;
}

/**
 * True when the pre-rebrand support directories may exist and be adopted. That
 * history only ever happened on macOS, so the one-time rename stays there.
 */
export function legacySupportDirectoryMigration(): boolean {
  return process.platform === 'darwin';
}

/**
 * Well-known Chromium/Chrome/Edge installations to fall back on when the
 * Playwright-managed browser is absent (a friendlier developer setup; packaged
 * builds always ship their own). Ordered by preference.
 */
export function installedBrowserCandidates(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      ];
    case 'win32': {
      // Skip an entry entirely when its Program Files root is not set, rather
      // than probing a relative path.
      const programFiles = process.env.PROGRAMFILES?.trim();
      const programFilesX86 = process.env['PROGRAMFILES(X86)']?.trim();
      return [
        programFiles && path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        programFilesX86 &&
          path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ].filter((candidate): candidate is string => Boolean(candidate));
    }
    default:
      return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  }
}

/** Fire-and-forget spawn for desktop shell actions (never blocks the agent). */
function spawnDetached(
  command: string,
  args: string[],
  options: { windowsVerbatimArguments?: boolean } = {}
): void {
  spawn(command, args, { shell: false, detached: true, stdio: 'ignore', ...options }).unref();
}

/**
 * The one door to the user's file manager.
 *
 * Eight call sites handed a path straight to `open`, `explorer.exe` or
 * `xdg-open`. Each one is a request from the browser naming a file, and the
 * verb on the other side is "do whatever this system does with this" — which
 * for a `.command`, a `.desktop` entry or a script means execute it. The paths
 * are ones the agent produced, so none of this was reachable in practice; it
 * was reachable in one edit, at any of eight places, by someone who had no
 * reason to know the rule.
 *
 * Now there is one place, and it refuses anything that is not a regular file or
 * a directory that exists right now. When the path ledger lands this is where it
 * gets consulted, for the same reason: one door.
 */
export function showInFileManager(target: string, options: { reveal?: boolean } = {}): boolean {
  if (!path.isAbsolute(target)) return false;
  let entry: Stats;
  try {
    // `stat`, not `lstat`: a symlink to a real file is a perfectly ordinary
    // thing for a user to have, and following it is what the file manager
    // would do anyway. What is refused is the target being something other
    // than a file or a directory — a FIFO, a device, a socket.
    entry = statSync(target);
  } catch {
    return false;
  }
  if (!entry.isFile() && !entry.isDirectory()) return false;
  if (options.reveal) revealInFileManager(target);
  else openPath(target);
  return true;
}

/** Shows the file selected in the OS file manager (Finder/Explorer). */
function revealInFileManager(filePath: string): void {
  switch (process.platform) {
    case 'darwin':
      spawnDetached('/usr/bin/open', ['-R', filePath]);
      return;
    case 'win32':
      // Explorer wants `/select,"C:\path"` — the switch joined to the quoted
      // path. Node quotes any argument with a space as a whole, which turns it
      // into `"/select,C:\path"`; Explorer does not recognise that, and shows
      // the default folder instead of the file. So the argument is built here
      // and passed verbatim. A Windows path cannot contain a double quote.
      spawnDetached('explorer.exe', [`/select,"${filePath}"`], {
        windowsVerbatimArguments: true
      });
      return;
    default:
      // No portable "select file" verb; open the containing folder instead.
      spawnDetached('xdg-open', [path.dirname(filePath)]);
  }
}

/** Opens a file or folder with its default application/file manager. */
function openPath(target: string): void {
  switch (process.platform) {
    case 'darwin':
      spawnDetached('/usr/bin/open', [target]);
      return;
    case 'win32':
      spawnDetached('explorer.exe', [target]);
      return;
    default:
      spawnDetached('xdg-open', [target]);
  }
}

/**
 * System tar: the absolute macOS path the agent always used, `tar.exe`
 * (bsdtar, bundled since Windows 10 1803) on PATH elsewhere.
 */
function tarExecutable(): string {
  if (process.platform === 'darwin') return '/usr/bin/tar';
  if (process.platform === 'linux') return 'bsdtar';
  return executableName('tar');
}

/** Lists the entry names of a gzipped tarball (used for layout validation). */
export async function listTarGzEntries(archivePath: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)(tarExecutable(), ['-tzf', archivePath], {
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout.split(/\r?\n/u).filter(Boolean);
}

/** Extracts a gzipped tarball into an existing destination directory. */
export async function extractTarGz(archivePath: string, destination: string): Promise<void> {
  await promisify(execFile)(tarExecutable(), ['-xzf', archivePath, '-C', destination]);
}

/**
 * Lists the entry names of a ZIP archive (used for layout validation before
 * unzipArchive). bsdtar reads zip natively, and both supported desktop
 * platforms ship bsdtar: /usr/bin/tar on macOS, tar.exe on Windows 10 1803+.
 */
export async function listZipEntries(zipPath: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)(tarExecutable(), ['-tf', zipPath], {
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout.split(/\r?\n/u).filter(Boolean);
}

interface CommandResult {
  code: number | null;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.once('error', error => {
      stderr += error.message;
      resolve({ code: 1, stderr });
    });
    child.once('close', code => resolve({ code, stderr }));
  });
}

/**
 * Zips a directory so the archive contains the directory itself as its single
 * top-level entry. macOS keeps using `ditto`; elsewhere the pure-JS writer
 * records UTF-8 entry names explicitly, avoiding both bsdtar's Windows code
 * page ambiguity and PowerShell startup/policy failures.
 */
export async function zipDirectory(dir: string, zipPath: string): Promise<void> {
  const result =
    process.platform === 'darwin'
      ? await runCommand('/usr/bin/ditto', ['-c', '-k', '--keepParent', dir, zipPath])
      : await writeZipDirectory(dir, zipPath).then(
          () => ({ code: 0, stderr: '' }),
          error => ({ code: 1, stderr: error instanceof Error ? error.message : String(error) })
        );
  if (result.code !== 0) {
    throw new Error(`Could not create the archive: ${result.stderr.trim() || 'unknown error'}`);
  }
}

/** Extracts a ZIP archive into a destination directory. */
export async function unzipArchive(zipPath: string, destination: string): Promise<void> {
  if (process.platform === 'win32') {
    // Windows system archive tools interpret some entry names through an
    // active code page. The validated Node reader consumes the ZIP's explicit
    // UTF-8 names, so extraction does not depend on a shell locale.
    await extractZipSafely(zipPath, destination);
    return;
  }
  const result =
    process.platform === 'darwin'
      ? await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, destination])
      : await runCommand(tarExecutable(), ['-xf', zipPath, '-C', destination]);
  if (result.code !== 0) {
    throw new Error(`Could not unpack the archive: ${result.stderr.trim() || 'unknown error'}`);
  }
}

/**
 * True when the platform *has* the mechanism, whether or not it still works.
 *
 * The gate for resuming, which must keep trying whatever the helper's history:
 * suspension on Windows outlives the process that asked for it, so refusing a
 * resume because the helper has been given up on would strand whatever is
 * already frozen for the rest of the session.
 */
function platformCanPause(): boolean {
  return capabilities().processPause;
}

/**
 * True when the platform can suspend a child process *right now*.
 *
 * A live read, not a per-platform constant. On Windows the mechanism is a
 * helper process, and a helper that has given up on starting takes the
 * capability with it — the throttle degrades to spawn-time limits. Reporting
 * the constant instead is how the interface ends up showing a lever that does
 * nothing (A1).
 */
export function processPauseSupported(): boolean {
  if (!platformCanPause()) return false;
  return !(process.platform === 'win32' && windowsSuspend?.disabled() === true);
}

/** Listeners for the moment the capability is lost, so the change can be broadcast. */
const pauseSupportListeners = new Set<() => void>();

/**
 * Subscribes to changes in `processPauseSupported()`. Returns an unsubscribe.
 *
 * Only the loss is announced today, because that is the only transition the
 * helper can make on its own: it gives up for the session and does not come
 * back. Callers should re-read `processPauseSupported()` rather than assume a
 * direction, so a future recovery needs no change here.
 */
export function onProcessPauseSupportChange(listener: () => void): () => void {
  pauseSupportListeners.add(listener);
  return () => {
    pauseSupportListeners.delete(listener);
  };
}

function announcePauseSupportChange(): void {
  // Copied before iterating: a listener that unsubscribes itself while being
  // called would otherwise mutate the set mid-walk.
  for (const listener of [...pauseSupportListeners]) listener();
}

/**
 * The Windows suspend helper, created on first use so a machine that never
 * throttles never spawns it.
 */
let windowsSuspend: WindowsSuspendHelper | null = null;

function windowsSuspendHelper(): WindowsSuspendHelper {
  windowsSuspend ??= new WindowsSuspendHelper({ onDisabled: announcePauseSupportChange });
  return windowsSuspend;
}

/** Injectable for tests, which must never spawn a real PowerShell. */
export function setWindowsSuspendHelper(helper: WindowsSuspendHelper | null): void {
  windowsSuspend = helper;
  // Swapping the helper can change the answer `processPauseSupported()` gives,
  // so it is a support change like any other. An injected helper reports its
  // own later give-up only if the caller wired `onDisabled`; the live read
  // above covers it regardless.
  announcePauseSupportChange();
}

/** Tears down the resident helper, if one was ever started. */
export async function shutdownProcessPause(): Promise<void> {
  const helper = windowsSuspend;
  windowsSuspend = null;
  await helper?.shutdown();
}

/**
 * Suspends a child process. Returns false when the signal could not be
 * delivered; callers must be prepared to continue with the process still
 * running.
 *
 * Takes the `ChildProcess` rather than its PID wherever one is available:
 * `child.kill` refuses to signal a process that has already been reaped, which
 * is the only cheap protection against a recycled PID landing our SIGSTOP on
 * something unrelated.
 */
export function pauseProcess(child: ChildProcess): boolean {
  if (!processPauseSupported()) return false;
  try {
    if (process.platform === 'win32')
      return typeof child.pid === 'number' && windowsSuspendHelper().suspend(child.pid);
    return child.kill('SIGSTOP');
  } catch {
    return false;
  }
}

/** Resumes a process previously paused with pauseProcess. */
export function resumeProcess(child: ChildProcess): boolean {
  if (!platformCanPause()) return false;
  try {
    if (process.platform === 'win32')
      return typeof child.pid === 'number' && windowsSuspendHelper().resume(child.pid);
    return child.kill('SIGCONT');
  } catch {
    return false;
  }
}

/**
 * Suspends a process we did not spawn, by PID.
 *
 * This exists for descendants — Chromium's renderers under Playwright, and any
 * other tool that fans out — which have no `ChildProcess` on this side. Only
 * ever called with a PID that a recent process-table snapshot reported as a
 * descendant of one of our own children, because unlike `pauseProcess` there is
 * no reaped-child guard here to catch a PID the OS has recycled.
 */
export function pauseProcessId(pid: number): boolean {
  if (!processPauseSupported() || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') return windowsSuspendHelper().suspend(pid);
    process.kill(pid, 'SIGSTOP');
    return true;
  } catch {
    // ESRCH is the normal case: the descendant finished between the snapshot
    // and the signal.
    return false;
  }
}

/** Resumes a process previously paused with `pauseProcessId`. */
export function resumeProcessId(pid: number): boolean {
  if (!platformCanPause() || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') return windowsSuspendHelper().resume(pid);
    process.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

const WINDOWS_RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Makes a user-supplied name safe to use as a file/directory name on every
 * platform (applied uniformly so results are predictable): path separators and
 * Windows-forbidden characters collapse to a single dash, control characters
 * are dropped, trailing dots/spaces are trimmed, and Windows-reserved device
 * names are prefixed. Returns '' when nothing usable remains.
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/gu, '')
    .replace(/[\\/:*?"<>|]+/gu, '-')
    .trim()
    .replace(/[. ]+$/u, '');
  if (!cleaned) return '';
  // Windows reserves device names even with an extension (e.g. `con.txt`).
  const stem = cleaned.split('.', 1)[0];
  return WINDOWS_RESERVED_BASENAMES.test(stem) ? `_${cleaned}` : cleaned;
}

/* ── Local-resource measurement ──────────────────────────────────────────── */

/**
 * One row of the process table: a PID and its parent. Used to walk a tool's
 * descendants, which matters for Playwright's Chromium (a renderer tree) —
 * measuring only the direct child would under-report what Soty is consuming.
 */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
}

/**
 * True when this host can report per-process CPU time at all.
 *
 * Probed once rather than assumed. `PowerSample` models "unavailable" as a
 * union member precisely so the readout can say *why* it has no figure, and
 * answering `true` unconditionally collapsed that: a host without the tool
 * would fail the first probe and be reported as an error — "something broke" —
 * rather than as a machine that simply cannot measure this.
 */
let metricsSupported: boolean | null = null;
export function processMetricsSupported(): boolean {
  metricsSupported ??= process.platform === 'win32' || existsSync('/bin/ps');
  return metricsSupported;
}

function usesPowerShellMetrics(): boolean {
  return process.platform === 'win32';
}

/**
 * Snapshot of every process's PID and parent PID.
 *
 * Deliberately one batched call rather than per-PID probing: the sampler runs
 * once a second while a viewer is watching, and the measurement must not itself
 * become a meaningful share of the load it reports.
 */
export async function processTableSnapshot(): Promise<ProcessTableRow[]> {
  const { stdout } = usesPowerShellMetrics()
    ? await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
        ],
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true }
      )
    : await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid='], {
        maxBuffer: 8 * 1024 * 1024
      });
  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/u);
    const parsedPid = Number(pid);
    const parsedPpid = Number(ppid);
    if (Number.isInteger(parsedPid) && Number.isInteger(parsedPpid))
      rows.push({ pid: parsedPid, ppid: parsedPpid });
  }
  return rows;
}

/**
 * Cumulative CPU time consumed by each of `pids`, in seconds.
 *
 * Cumulative time, never `ps %cpu`: on macOS that column is a decaying
 * lifetime average, so a readout built on it would lag the lever by tens of
 * seconds. Differencing two cumulative readings gives a true instantaneous
 * rate.
 */
export async function processCpuSeconds(pids: readonly number[]): Promise<Map<number, number>> {
  // Only integers ever reach a command line here, and they are filtered on this
  // side rather than trusted from the caller.
  const usable = pids.filter(pid => Number.isInteger(pid) && pid > 0);
  if (usable.length === 0) return new Map();

  if (usesPowerShellMetrics()) {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Id ${usable.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalSeconds)" }`
      ],
      { maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
    const times = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const [pid, seconds] = line.trim().split(/\s+/u);
      const parsedPid = Number(pid);
      const parsedSeconds = Number(seconds);
      if (Number.isInteger(parsedPid) && Number.isFinite(parsedSeconds))
        times.set(parsedPid, parsedSeconds);
    }
    return times;
  }

  const { stdout } = await promisify(execFile)(
    '/bin/ps',
    ['-o', 'pid=,time=', '-p', usable.join(',')],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const times = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const [pid, time] = line.trim().split(/\s+/u);
    const parsedPid = Number(pid);
    const seconds = parseCpuTime(time);
    if (Number.isInteger(parsedPid) && seconds !== null) times.set(parsedPid, seconds);
  }
  return times;
}

/** Parses `ps` elapsed-CPU notation: `[[dd-]hh:]mm:ss[.ff]`. */
export function parseCpuTime(value: string | undefined): number | null {
  if (!value) return null;
  const [days, rest] = value.includes('-') ? value.split('-', 2) : [null, value];
  const parts = rest.split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  if (days !== null) {
    const parsedDays = Number(days);
    if (!Number.isFinite(parsedDays)) return null;
    seconds += parsedDays * 86_400;
  }
  return seconds;
}

/* ── Where a dropped file is looked for ──────────────────────────────────────
   A browser drop carries a file's name, size and modification time, never its
   path. The agent finds the original on disk from those three facts: first in
   the folders people drag from, then through the OS file index. Both halves
   are platform-shaped, so both live here. */

/** The folder names people ordinarily drag files from, as the OS names them. */
const COMMON_CONTENT_FOLDERS = ['Downloads', 'Desktop', 'Movies', 'Videos', 'Documents'];

/** The Downloads folder has no `[Environment+SpecialFolder]` name; this is its known-folder id. */
const WINDOWS_DOWNLOADS_FOLDER_ID = '{374DE290-123F-4565-9164-39C4925E467B}';

/**
 * Asks Windows where the user's Desktop, Documents, Videos and Downloads really
 * are. On a typical Windows 10/11 install OneDrive moves the first three into
 * `~/OneDrive/...` ("Known Folder Move"), so `~/Desktop` is either empty or
 * missing and a drop from the real desktop is never found by name. PowerShell
 * reads the same registry Explorer does and prints the paths in UTF-8, which
 * `reg.exe` would not (it writes the console code page, mangling a Cyrillic
 * user name). One line per folder; nothing else is printed.
 */
const WINDOWS_KNOWN_FOLDERS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$shell = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'",
  `$downloads = $shell.'${WINDOWS_DOWNLOADS_FOLDER_ID}'`,
  'if ($downloads) { [Console]::Out.WriteLine([Environment]::ExpandEnvironmentVariables($downloads)) }',
  "foreach ($name in 'Desktop', 'MyVideos', 'MyDocuments') { [Console]::Out.WriteLine([Environment]::GetFolderPath($name)) }"
].join('\n');

const KNOWN_FOLDERS_TIMEOUT_MS = 8_000;

/** Windows PowerShell by its full path when the system root is known; by name otherwise. */
export function windowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot?.trim() || process.env.windir?.trim();
  return systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

/** PowerShell single-quoted literal: only the quote itself needs doubling. */
export function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Runs a PowerShell snippet with its console hidden and returns stdout lines, or [] on any failure. */
function powerShellLines(script: string, timeoutMs: number): Promise<string[]> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(
        windowsPowerShell(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch {
      resolve([]);
      return;
    }
    let output = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (output.length < 256 * 1024) output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? output
              .split(/\r?\n/u)
              .map(line => line.trim())
              .filter(Boolean)
          : []
      );
    });
  });
}

/**
 * Merges the folders Windows reported with the defaults and the OneDrive roots the
 * environment names (`OneDrive`, `OneDriveConsumer`, `OneDriveCommercial`), in
 * that order, without duplicates. Exported for its test; the public door is
 * {@link userContentFolders}.
 */
export function mergeWindowsContentFolders(
  home: string,
  reported: readonly string[],
  env: NodeJS.ProcessEnv
): string[] {
  const roots = [home];
  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[name]?.trim();
    if (root && path.win32.isAbsolute(root)) roots.push(root);
  }
  const candidates = [
    ...reported,
    ...roots.flatMap(root => COMMON_CONTENT_FOLDERS.map(folder => path.win32.join(root, folder)))
  ];
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const candidate of candidates) {
    if (!path.win32.isAbsolute(candidate)) continue;
    const key = path.win32.normalize(candidate).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(path.win32.normalize(candidate));
  }
  return folders;
}

let windowsContentFolders: { home: string; folders: Promise<string[]> } | null = null;

/**
 * The folders a dropped file is looked for in, by absolute path.
 *
 * macOS and Linux: the common folders under home. Windows: the same names, but
 * where the user's known folders actually are (OneDrive redirection included),
 * resolved once per agent lifetime and remembered.
 */
export function userContentFolders(): Promise<string[]> {
  const home = os.homedir();
  if (process.platform !== 'win32')
    return Promise.resolve(COMMON_CONTENT_FOLDERS.map(folder => path.join(home, folder)));
  if (windowsContentFolders?.home !== home) {
    windowsContentFolders = {
      home,
      folders: powerShellLines(WINDOWS_KNOWN_FOLDERS_SCRIPT, KNOWN_FOLDERS_TIMEOUT_MS).then(
        reported => mergeWindowsContentFolders(home, reported, process.env)
      )
    };
  }
  return windowsContentFolders.folders;
}

const INDEXED_SEARCH_TIMEOUT_MS = 6_000;

/**
 * Windows Search's SQL for "every indexed file with exactly this name". The
 * name is a literal inside single quotes, so a quote in it is doubled; nothing
 * else in a file name is special to this dialect. Exported for its test.
 */
export function windowsSearchSql(fileName: string): string {
  return `SELECT TOP 50 System.ItemPathDisplay FROM SYSTEMINDEX WHERE System.FileName = '${fileName.replaceAll("'", "''")}'`;
}

function windowsSearchScript(fileName: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$connection = New-Object System.Data.OleDb.OleDbConnection \'Provider=Search.CollatorDSO;Extended Properties="Application=Windows"\'',
    '$command = $connection.CreateCommand()',
    `$command.CommandText = ${powerShellQuote(windowsSearchSql(fileName))}`,
    '$connection.Open()',
    'try {',
    '  $reader = $command.ExecuteReader()',
    '  while ($reader.Read()) { [Console]::Out.WriteLine($reader.GetString(0)) }',
    '  $reader.Close()',
    '} finally { $connection.Close() }'
  ].join('\n');
}

/**
 * Asks the OS file index for files with this exact name: Spotlight on macOS
 * (`mdfind`, by argument rather than by query so there is nothing to escape),
 * Windows Search on Windows (the same index Explorer's search box uses). Both
 * are a hint, not an answer — every candidate is still checked against size
 * and modification time by the caller. Resolves to [] wherever there is no
 * index, where it is off, or where it does not answer in time.
 */
export function indexedFileSearch(root: string, fileName: string): Promise<string[]> {
  switch (process.platform) {
    case 'darwin':
      return new Promise(resolve => {
        const child = spawn('/usr/bin/mdfind', ['-onlyin', root, '-name', fileName], {
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore']
        });
        let output = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          if (output.length < 64 * 1024) output += chunk;
        });
        child.once('error', () => {
          clearTimeout(timer);
          resolve([]);
        });
        child.once('close', () => {
          clearTimeout(timer);
          resolve(output.split('\n').filter(Boolean));
        });
      });
    case 'win32':
      // The index spans every indexed drive, which is the point: a video kept on
      // D:\ is exactly the drop the bounded folder walk cannot find.
      return powerShellLines(windowsSearchScript(fileName), INDEXED_SEARCH_TIMEOUT_MS).then(lines =>
        lines.filter(line => path.win32.isAbsolute(line))
      );
    default:
      return Promise.resolve([]);
  }
}
