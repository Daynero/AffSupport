import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

const processMock = vi.hoisted(() => ({
  unref: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn()
}));

vi.mock('node:child_process', () => ({
  spawn: processMock.spawn,
  execFile: processMock.execFile
}));

import {
  appSupportRoot,
  capabilities,
  executableName,
  listZipEntries,
  showInFileManager,
  pauseProcess,
  processPauseSupported,
  resumeProcess,
  sanitizeFileName
} from '../apps/agent/src/platform/platform.js';

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
}

beforeEach(() => {
  processMock.unref.mockReset();
  processMock.spawn.mockReset().mockReturnValue({ unref: processMock.unref });
  processMock.execFile.mockReset();
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
});

describe('executableName', () => {
  it('leaves names untouched on macOS and Linux', () => {
    setPlatform('darwin');
    expect(executableName('ffmpeg')).toBe('ffmpeg');
    setPlatform('linux');
    expect(executableName('whisper-cli')).toBe('whisper-cli');
  });

  it('appends .exe on Windows', () => {
    setPlatform('win32');
    expect(executableName('ffmpeg')).toBe('ffmpeg.exe');
    expect(executableName('llama-server')).toBe('llama-server.exe');
  });
});

describe('appSupportRoot', () => {
  it('uses Application Support on macOS', () => {
    setPlatform('darwin');
    expect(appSupportRoot()).toBe(path.join(os.homedir(), 'Library', 'Application Support'));
  });

  it('prefers %APPDATA% on Windows and falls back to Roaming', () => {
    setPlatform('win32');
    vi.stubEnv('APPDATA', 'C:\\Users\\roman\\AppData\\Roaming');
    expect(appSupportRoot()).toBe('C:\\Users\\roman\\AppData\\Roaming');
    vi.stubEnv('APPDATA', '');
    expect(appSupportRoot()).toBe(path.join(os.homedir(), 'AppData', 'Roaming'));
  });

  it('uses the XDG data home on Linux', () => {
    setPlatform('linux');
    expect(appSupportRoot()).toBe(path.join(os.homedir(), '.local', 'share'));
  });
});

describe('capabilities', () => {
  it('exposes the full macOS feature set', () => {
    setPlatform('darwin');
    expect(capabilities()).toEqual({
      nativeFilePicker: true,
      revealInFileManager: true,
      spotlightSearch: true,
      shellContextMenuIntegration: true,
      processPause: true
    });
  });

  it('keeps pickers and reveal on Windows and gates Spotlight off', () => {
    setPlatform('win32');
    expect(capabilities()).toEqual({
      nativeFilePicker: true,
      revealInFileManager: true,
      spotlightSearch: false,
      // No Explorer shell extension ships.
      shellContextMenuIntegration: false,
      // Windows has no SIGSTOP, but it does have NtSuspendProcess: the power
      // throttle drives it through a resident PowerShell helper, so suspension
      // is genuinely available here now.
      processPause: true
    });
  });

  it('gates macOS-only features off on Linux', () => {
    setPlatform('linux');
    expect(capabilities()).toEqual({
      nativeFilePicker: false,
      revealInFileManager: true,
      spotlightSearch: false,
      shellContextMenuIntegration: false,
      processPause: true
    });
  });
});

describe('file manager actions', () => {
  /**
   * Real paths, because the door checks that the target exists and is a file or
   * a directory before handing it to the system. That check is the point of the
   * door: the alternative is eight call sites each passing whatever they were
   * given to a verb that means "do whatever this system does with this".
   */
  const realFile = fileURLToPath(import.meta.url);
  const realDirectory = path.dirname(realFile);

  it('refuses a path that does not exist', () => {
    setPlatform('darwin');
    expect(showInFileManager('/definitely/not/here.mov')).toBe(false);
    expect(processMock.spawn).not.toHaveBeenCalled();
  });

  it('refuses a relative path', () => {
    setPlatform('darwin');
    expect(showInFileManager('relative/clip.mov')).toBe(false);
    expect(processMock.spawn).not.toHaveBeenCalled();
  });

  it('reveals via open -R on macOS', () => {
    setPlatform('darwin');
    expect(showInFileManager(realFile, { reveal: true })).toBe(true);
    expect(processMock.spawn).toHaveBeenCalledWith('/usr/bin/open', ['-R', realFile], {
      shell: false,
      detached: true,
      stdio: 'ignore'
    });
    expect(processMock.unref).toHaveBeenCalledOnce();
  });

  it('opens paths via open on macOS', () => {
    setPlatform('darwin');
    expect(showInFileManager(realDirectory)).toBe(true);
    expect(processMock.spawn).toHaveBeenCalledWith('/usr/bin/open', [realDirectory], {
      shell: false,
      detached: true,
      stdio: 'ignore'
    });
  });

  it('uses Explorer with a /select, argument on Windows', () => {
    setPlatform('win32');
    expect(showInFileManager(realFile, { reveal: true })).toBe(true);
    expect(processMock.spawn).toHaveBeenCalledWith('explorer.exe', [`/select,${realFile}`], {
      shell: false,
      detached: true,
      stdio: 'ignore'
    });
    expect(showInFileManager(realDirectory)).toBe(true);
    expect(processMock.spawn).toHaveBeenLastCalledWith('explorer.exe', [realDirectory], {
      shell: false,
      detached: true,
      stdio: 'ignore'
    });
  });
});

describe('listZipEntries', () => {
  it('lists zip entries through bsdtar with the platform-specific executable', async () => {
    processMock.execFile.mockImplementation((_command, _args, _options, callback) =>
      callback(null, { stdout: 'llama-server.exe\nggml.dll\n\n' })
    );

    setPlatform('darwin');
    await expect(listZipEntries('/tmp/llama.zip')).resolves.toEqual([
      'llama-server.exe',
      'ggml.dll'
    ]);
    expect(processMock.execFile).toHaveBeenLastCalledWith(
      '/usr/bin/tar',
      ['-tf', '/tmp/llama.zip'],
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
      expect.any(Function)
    );

    setPlatform('win32');
    await expect(listZipEntries('C:\\downloads\\llama.zip')).resolves.toEqual([
      'llama-server.exe',
      'ggml.dll'
    ]);
    expect(processMock.execFile).toHaveBeenLastCalledWith(
      'tar.exe',
      ['-tf', 'C:\\downloads\\llama.zip'],
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
      expect.any(Function)
    );
  });
});

describe('process pause and resume', () => {
  function fakeChild(killResult: boolean | (() => boolean)) {
    return {
      kill: vi.fn(() => (typeof killResult === 'function' ? killResult() : killResult))
    } as unknown as ChildProcess;
  }

  it('sends SIGSTOP/SIGCONT on macOS', () => {
    setPlatform('darwin');
    expect(processPauseSupported()).toBe(true);
    const child = fakeChild(true);
    expect(pauseProcess(child)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGSTOP');
    expect(resumeProcess(child)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGCONT');
  });

  it('reports an undeliverable signal as false instead of throwing', () => {
    setPlatform('darwin');
    expect(pauseProcess(fakeChild(false))).toBe(false);
    const throwing = fakeChild(() => {
      throw new Error('ESRCH');
    });
    expect(pauseProcess(throwing)).toBe(false);
    expect(resumeProcess(throwing)).toBe(false);
  });

  it('pauses on Windows through the helper rather than a signal', () => {
    setPlatform('win32');
    expect(processPauseSupported()).toBe(true);
    const child = fakeChild(true);
    // Windows never receives SIGSTOP — the signal simply does not exist there,
    // so delivering one would be a silent no-op. See
    // tests/power-windows-suspend.test.ts for the helper protocol itself.
    pauseProcess(child);
    resumeProcess(child);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('sanitizeFileName', () => {
  it('keeps ordinary names, including unicode, unchanged', () => {
    expect(sanitizeFileName('My Landing 2')).toBe('My Landing 2');
    expect(sanitizeFileName('Ölçüm-раз.два')).toBe('Ölçüm-раз.два');
  });

  it('collapses separators and Windows-forbidden characters to one dash', () => {
    expect(sanitizeFileName('a//b\\c')).toBe('a-b-c');
    expect(sanitizeFileName('video: *final*?')).toBe('video- -final-');
    expect(sanitizeFileName('<a>|"b"')).toBe('-a-b-');
  });

  it('drops control characters and trailing dots or spaces', () => {
    expect(sanitizeFileName('name\u0000\u001f\u007f')).toBe('name');
    expect(sanitizeFileName('archive...')).toBe('archive');
    expect(sanitizeFileName('archive . .')).toBe('archive');
  });

  it('defuses Windows-reserved device names, extensions included', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('com1')).toBe('_com1');
    expect(sanitizeFileName('NUL.txt')).toBe('_NUL.txt');
    expect(sanitizeFileName('console')).toBe('console');
    expect(sanitizeFileName('COM10')).toBe('COM10');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(sanitizeFileName('')).toBe('');
    expect(sanitizeFileName(' ')).toBe('');
    expect(sanitizeFileName('...')).toBe('');
  });
});
