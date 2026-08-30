// A cancelled AppleScript dialog reports error -128 with a localized message,
// so matching only the English "User canceled" turned every cancel on a
// non-English macOS into a failure. These cover both wordings and a genuine
// failure, with a stubbed spawn (osascript cannot be driven headlessly).
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const processMock = {
  spawn: vi.fn()
};

vi.mock('node:child_process', () => ({
  spawn: processMock.spawn
}));

const { selectOutputFolder, selectVideos } = await import('../apps/agent/src/files/picker.js');

const realPlatform = process.platform;

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function stubRun({ stdout = '', stderr = '', code = 0 } = {}) {
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

beforeEach(() => {
  processMock.spawn.mockReset();
  Object.defineProperty(process, 'platform', { value: 'darwin' });
});

describe('macOS picker cancellation', () => {
  it('treats an English cancel as an empty selection', async () => {
    stubRun({ stderr: 'execution error: User canceled. (-128)', code: 1 });
    await expect(selectVideos()).resolves.toEqual([]);
  });

  it('treats a localized cancel as an empty selection', async () => {
    stubRun({ stderr: 'execution error: Користувач скасував. (-128)', code: 1 });
    await expect(selectVideos()).resolves.toEqual([]);
  });

  it('still rejects a genuine picker failure', async () => {
    stubRun({ stderr: 'execution error: something actually broke. (-1728)', code: 1 });
    await expect(selectVideos()).rejects.toThrow();
  });

  it('returns null when a folder choice is cancelled in any language', async () => {
    stubRun({ stderr: 'execution error: Користувач скасував. (-128)', code: 1 });
    await expect(selectOutputFolder()).resolves.toBeNull();
  });
});

Object.defineProperty(process, 'platform', { value: realPlatform });
