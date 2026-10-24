import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: native.spawn, execFile: vi.fn() }));
import { recoveryCredential } from '../apps/agent/src/platform/platform';

const originalPlatform = process.platform;
const ACCOUNT = 'soty-recovery-synthetic-036';
const SECRET = 's'.repeat(43);

function platform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value });
}
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
}
function reply(code: number | null, output = '') {
  const process = child();
  native.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      if (output) process.stdout.write(output);
      process.emit('close', code);
    });
    return process;
  });
  return process;
}
beforeEach(() => {
  native.spawn.mockReset();
  platform('darwin');
});
afterEach(() => {
  platform(originalPlatform);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('writes through Keychain stdin and verifies the stored value before acknowledging setup', async () => {
  const writer = reply(0);
  reply(0, SECRET + '\n');
  await expect(recoveryCredential('write', ACCOUNT, SECRET)).resolves.toBeNull();
  expect(native.spawn).toHaveBeenCalledTimes(2);
  expect(native.spawn.mock.calls[0]).toEqual([
    '/usr/bin/security',
    ['-i'],
    { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  ]);
  expect(writer.stdin.read()?.toString()).toContain(`-a ${ACCOUNT} -w ${SECRET}\n`);
  expect(JSON.stringify(native.spawn.mock.calls)).not.toContain(SECRET);
});

it('refuses setup when Keychain did not persist the exact value', async () => {
  reply(0);
  reply(0, 'different');
  await expect(recoveryCredential('write', ACCOUNT, SECRET)).rejects.toThrow('AGENT_REQUIRED');
});

it('distinguishes a missing Keychain item from a storage failure', async () => {
  reply(44);
  await expect(recoveryCredential('read', ACCOUNT)).resolves.toBeNull();
  reply(1);
  await expect(recoveryCredential('read', ACCOUNT)).rejects.toThrow('AGENT_REQUIRED');
});

it.each([0, 44])('permits idempotent Keychain deletion with native exit %i', async code => {
  reply(code);
  await expect(recoveryCredential('delete', ACCOUNT)).resolves.toBeNull();
  expect(native.spawn.mock.calls[0][1][0]).toBe('delete-generic-password');
});

it('does not acknowledge failed Keychain writes or deletion', async () => {
  reply(1);
  await expect(recoveryCredential('write', ACCOUNT, SECRET)).rejects.toThrow('AGENT_REQUIRED');
  expect(native.spawn).toHaveBeenCalledTimes(1);
  reply(1);
  await expect(recoveryCredential('delete', ACCOUNT)).rejects.toThrow('AGENT_REQUIRED');
});

it.each(['read', 'write', 'delete'] as const)(
  'passes Windows %s data through stdin to user-bound DPAPI, keeping secrets out of arguments',
  async action => {
    platform('win32');
    vi.stubEnv('APPDATA', 'C:\\Synthetic\\Roaming');
    const process = reply(0, action === 'read' ? SECRET : '');
    await expect(
      recoveryCredential(action, ACCOUNT, action === 'write' ? SECRET : undefined)
    ).resolves.toBe(action === 'read' ? SECRET : null);
    const [command, args, options] = native.spawn.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(options).toMatchObject({ shell: false, windowsHide: true });
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    expect(script).toContain('DataProtectionScope]::CurrentUser');
    expect(script).toContain('Move-Item -LiteralPath $t -Destination $p -Force');
    expect(script).not.toContain('LocalMachine');
    expect(JSON.stringify(native.spawn.mock.calls)).not.toContain(SECRET);
    const input = JSON.parse(process.stdin.read()!.toString());
    expect(input).toMatchObject({ action, file: expect.stringContaining(`${ACCOUNT}.bin`) });
    expect(input.value).toBe(action === 'write' ? SECRET : undefined);
  }
);

it('keeps missing Windows credentials distinct from native command failure', async () => {
  platform('win32');
  reply(0);
  await expect(recoveryCredential('read', ACCOUNT)).resolves.toBeNull();
  reply(null);
  await expect(recoveryCredential('read', ACCOUNT)).rejects.toThrow('AGENT_REQUIRED');
});

it('rejects invalid accounts and payloads before spawning any native command', async () => {
  for (const [account, value] of [
    ['untrusted-account', SECRET],
    [ACCOUNT, 'contains whitespace'],
    [ACCOUNT, 's'.repeat(524289)],
    [ACCOUNT, '']
  ]) {
    await expect(recoveryCredential('write', account, value)).rejects.toThrow('INVALID_INPUT');
  }
  expect(native.spawn).not.toHaveBeenCalled();
  platform('linux');
  await expect(recoveryCredential('read', ACCOUNT)).rejects.toThrow('AGENT_REQUIRED');
  expect(native.spawn).not.toHaveBeenCalled();
});

it('bounds native output and reports oversized credentials instead of returning truncated data', async () => {
  const process = child();
  native.spawn.mockReturnValue(process);
  const result = recoveryCredential('read', ACCOUNT);
  const assertion = expect(result).rejects.toThrow('TOO_LARGE');
  process.stdout.write(Buffer.alloc(524289, 's'));
  expect(process.kill).toHaveBeenCalledOnce();
  process.emit('close', 0);
  await assertion;
});

it('requests termination of an unresponsive native store at its timeout and reports spawn errors safely', async () => {
  vi.useFakeTimers();
  const process = child();
  native.spawn.mockReturnValueOnce(process);
  const result = recoveryCredential('read', ACCOUNT);
  const assertion = expect(result).rejects.toThrow('AGENT_REQUIRED');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(process.kill).toHaveBeenCalledOnce();
  process.emit('close', 1);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
  const failed = child();
  native.spawn.mockReturnValueOnce(failed);
  const failure = expect(recoveryCredential('read', ACCOUNT)).rejects.toThrow('AGENT_REQUIRED');
  failed.emit('error', new Error('synthetic native failure'));
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
