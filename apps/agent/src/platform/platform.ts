import { execFile, spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

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
  /** "Reveal in Finder/Explorer" style actions. */
  revealInFileManager: boolean;
  /** Content-indexed file search (Spotlight's mdfind on macOS). */
  spotlightSearch: boolean;
  /**
   * File-manager context-menu integration that calls back into the agent (the
   * macOS Finder Sync extension and image-conversion Services provider, which
   * drive `/native/media-actions/*`). A Windows counterpart would be an Explorer
   * shell extension and is deliberately not shipped.
   */
  shellContextMenuIntegration: boolean;
  /**
   * Suspending and resuming a running child process. Windows has no SIGSTOP, so
   * callers must be prepared to continue with the process still running.
   */
  processPause: boolean;
}

export function capabilities(): PlatformCapabilities {
  switch (process.platform) {
    case 'darwin':
      return {
        nativeFilePicker: true,
        revealInFileManager: true,
        spotlightSearch: true,
        shellContextMenuIntegration: true,
        processPause: true
      };
    case 'win32':
      // Pickers are PowerShell WinForms dialogs (files/picker.ts).
      return {
        nativeFilePicker: true,
        revealInFileManager: true,
        spotlightSearch: false,
        shellContextMenuIntegration: false,
        processPause: false
      };
    default:
      return {
        nativeFilePicker: false,
        revealInFileManager: true,
        spotlightSearch: false,
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
function spawnDetached(command: string, args: string[]): void {
  spawn(command, args, { shell: false, detached: true, stdio: 'ignore' }).unref();
}

/** Shows the file selected in the OS file manager (Finder/Explorer). */
export function revealInFileManager(filePath: string): void {
  switch (process.platform) {
    case 'darwin':
      spawnDetached('/usr/bin/open', ['-R', filePath]);
      return;
    case 'win32':
      // Explorer expects the switch and path as a single `/select,`-joined arg.
      spawnDetached('explorer.exe', [`/select,${filePath}`]);
      return;
    default:
      // No portable "select file" verb; open the containing folder instead.
      spawnDetached('xdg-open', [path.dirname(filePath)]);
  }
}

/** Opens a file or folder with its default application/file manager. */
export function openPath(target: string): void {
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
  return process.platform === 'darwin' ? '/usr/bin/tar' : executableName('tar');
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
 * top-level entry. macOS keeps using `ditto`; elsewhere bsdtar writes the zip
 * (`-a` selects the format from the `.zip` extension), which avoids PowerShell
 * startup/policy issues that make Compress-Archive fragile.
 */
export async function zipDirectory(dir: string, zipPath: string): Promise<void> {
  const result =
    process.platform === 'darwin'
      ? await runCommand('/usr/bin/ditto', ['-c', '-k', '--keepParent', dir, zipPath])
      : await runCommand(tarExecutable(), [
          '-a',
          '-cf',
          zipPath,
          '-C',
          path.dirname(dir),
          path.basename(dir)
        ]);
  if (result.code !== 0) {
    throw new Error(`Could not create the archive: ${result.stderr.trim() || 'unknown error'}`);
  }
}

/** Extracts a ZIP archive into a destination directory. */
export async function unzipArchive(zipPath: string, destination: string): Promise<void> {
  const result =
    process.platform === 'darwin'
      ? await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, destination])
      : await runCommand(tarExecutable(), ['-xf', zipPath, '-C', destination]);
  if (result.code !== 0) {
    throw new Error(`Could not unpack the archive: ${result.stderr.trim() || 'unknown error'}`);
  }
}

/** True when the platform can suspend/resume a child process (POSIX signals). */
export function processPauseSupported(): boolean {
  return capabilities().processPause;
}

/**
 * Suspends a child process. Returns false when the platform cannot pause
 * (Windows has no SIGSTOP) or the signal could not be delivered; callers must
 * be prepared to continue with the process still running.
 */
export function pauseProcess(child: ChildProcess): boolean {
  if (!processPauseSupported()) return false;
  try {
    return child.kill('SIGSTOP');
  } catch {
    return false;
  }
}

/** Resumes a process previously paused with pauseProcess. */
export function resumeProcess(child: ChildProcess): boolean {
  if (!processPauseSupported()) return false;
  try {
    return child.kill('SIGCONT');
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
