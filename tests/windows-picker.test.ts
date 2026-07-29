// Verifies the win32 PowerShell picker branch: exact spawn arguments, script
// contents, output parsing and Cancel semantics — everything that can be
// proven with a stubbed spawn. PowerShell itself cannot run on this machine,
// so the dialogs must additionally be checked live on Windows once
// (docs/WINDOWS.md, "What requires a Windows machine").
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn()
}));

vi.mock('node:child_process', () => ({
  spawn: processMock.spawn,
  execFile: processMock.execFile
}));

import {
  selectLandingFolders,
  selectLandingZips,
  selectOutputFolder,
  selectTranscribeMedia,
  selectVideos
} from '../apps/agent/src/files/picker.js';

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function stubPickerRun({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  processMock.spawn.mockReturnValueOnce(child);
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
    child.emit('close', code);
  });
  return child;
}

function lastSpawnCall() {
  const call = processMock.spawn.mock.calls.at(-1);
  if (!call) throw new Error('spawn was not called');
  return { command: call[0] as string, args: call[1] as string[], options: call[2] };
}

beforeEach(() => {
  processMock.spawn.mockReset();
  setPlatform('win32');
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe('Windows video picker', () => {
  it('spawns a non-interactive STA PowerShell with a multi-select OpenFileDialog', async () => {
    stubPickerRun({ stdout: 'C:\\Videos\\a.mp4\r\nC:\\Videos\\Ölçüm раз.mov\r\n' });
    await expect(selectVideos()).resolves.toEqual([
      'C:\\Videos\\a.mp4',
      'C:\\Videos\\Ölçüm раз.mov'
    ]);

    const { command, args, options } = lastSpawnCall();
    expect(command).toBe('powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-Command']);
    expect(options).toMatchObject({ shell: false, windowsHide: true });

    const script = args[4];
    expect(script).toContain('System.Windows.Forms.OpenFileDialog');
    expect(script).toContain('$dialog.Multiselect = $true');
    expect(script).toContain("$dialog.Title = 'Select videos to compress'");
    // Video extension filter mirrors SUPPORTED_VIDEO_EXTENSIONS in queue/queue.ts.
    expect(script).toContain(
      "$dialog.Filter = 'Videos (*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.mpg;*.mpeg;*.mts;*.m2ts)" +
        '|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.mpg;*.mpeg;*.mts;*.m2ts' +
        "|All files (*.*)|*.*'"
    );
    // UTF-8 output so unicode paths survive the pipe.
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
  });

  it('resolves to an empty list when the user cancels (no output, exit 0)', async () => {
    stubPickerRun({ stdout: '' });
    await expect(selectVideos()).resolves.toEqual([]);
  });

  it('rejects with the picker failure message on a non-zero exit', async () => {
    stubPickerRun({ stderr: 'Add-Type : assembly load failure', code: 1 });
    await expect(selectVideos()).rejects.toThrow('Could not open the native file picker.');
  });
});

describe('Windows transcription and landing pickers', () => {
  it('filters transcription media by the shared audio+video extension list', async () => {
    stubPickerRun({ stdout: 'C:\\Media\\talk.m4a\r\n' });
    await expect(selectTranscribeMedia()).resolves.toEqual(['C:\\Media\\talk.m4a']);
    const script = lastSpawnCall().args[4];
    expect(script).toContain("$dialog.Title = 'Select audio or video to transcribe'");
    for (const pattern of ['*.mp4', '*.mp3', '*.wav', '*.flac', '*.opus', '*.aif']) {
      expect(script).toContain(pattern);
    }
  });

  it('filters landing archives to *.zip', async () => {
    stubPickerRun({ stdout: 'C:\\Landings\\promo.zip\r\n' });
    await expect(selectLandingZips()).resolves.toEqual(['C:\\Landings\\promo.zip']);
    const script = lastSpawnCall().args[4];
    expect(script).toContain('ZIP archives (*.zip)');
  });

  it('picks a landing folder through FolderBrowserDialog (single selection)', async () => {
    stubPickerRun({ stdout: 'C:\\Landings\\my-landing\r\n' });
    await expect(selectLandingFolders()).resolves.toEqual(['C:\\Landings\\my-landing']);
    const script = lastSpawnCall().args[4];
    expect(script).toContain('System.Windows.Forms.FolderBrowserDialog');
    expect(script).toContain("$dialog.Description = 'Choose a landing folder'");
  });
});

describe('Windows output folder picker', () => {
  it('returns the selected folder', async () => {
    stubPickerRun({ stdout: 'C:\\Users\\roman\\Videos\\out\r\n' });
    await expect(selectOutputFolder()).resolves.toBe('C:\\Users\\roman\\Videos\\out');
    const script = lastSpawnCall().args[4];
    expect(script).toContain('System.Windows.Forms.FolderBrowserDialog');
    expect(script).toContain('$dialog.ShowNewFolderButton = $true');
  });

  it('returns null when the folder dialog is cancelled', async () => {
    stubPickerRun({ stdout: '' });
    await expect(selectOutputFolder()).resolves.toBeNull();
  });

  it('rejects with the folder failure message on a non-zero exit', async () => {
    stubPickerRun({ code: 1 });
    await expect(selectOutputFolder()).rejects.toThrow('Could not choose an output folder.');
  });
});
