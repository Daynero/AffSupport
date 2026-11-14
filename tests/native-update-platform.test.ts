import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const probes = vi.hoisted(() => ({ execFile: vi.fn(), realpath: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: probes.execFile
}));
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  realpathSync: probes.realpath
}));
import {
  nativeUpdateHostConfiguration,
  nativeUpdateHelperPids
} from '../apps/agent/src/platform/platform';
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
const absoluteRoot = path.parse(path.resolve(os.tmpdir())).root;
const host = {
  socketPath: path.join(absoluteRoot, 'soty-update.sock'),
  receiptDirectory: path.join(absoluteRoot, 'soty-update-state'),
  token: 'a'.repeat(64),
  launcherPid: 1111,
  bundleRoot: path.join(absoluteRoot, 'Synthetic Soty.app')
};
function platform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}
beforeEach(() => {
  platform('darwin');
  Object.defineProperty(process, 'getuid', { value: () => 501, configurable: true });
  probes.execFile.mockReset();
  probes.realpath.mockReset();
  for (const [key, value] of Object.entries({
    PACKAGED_APP: '1',
    AGENT_NATIVE_UPDATES: '1',
    AGENT_NATIVE_UPDATE_SOCKET: host.socketPath,
    AGENT_NATIVE_UPDATE_STATE: host.receiptDirectory,
    AGENT_NATIVE_UPDATE_TOKEN: host.token,
    AGENT_NATIVE_UPDATE_BUNDLE: host.bundleRoot,
    AGENT_LAUNCHER_PID: String(host.launcherPid)
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  if (uidDescriptor) Object.defineProperty(process, 'getuid', uidDescriptor);
  else Reflect.deleteProperty(process, 'getuid');
  vi.unstubAllEnvs();
});
it('requires the packaged Mac host, private absolute endpoints and an exact bounded launcher identity', () => {
  expect(nativeUpdateHostConfiguration()).toEqual(host);
  platform('win32');
  expect(nativeUpdateHostConfiguration()).toBeNull();
  platform('darwin');
  vi.stubEnv('PACKAGED_APP', '0');
  expect(nativeUpdateHostConfiguration()).toBeNull();
  vi.stubEnv('PACKAGED_APP', '1');
  vi.stubEnv('AGENT_NATIVE_UPDATES', '0');
  expect(nativeUpdateHostConfiguration()).toBeNull();
});
it.each([
  ['AGENT_NATIVE_UPDATE_SOCKET', 'relative.sock'],
  ['AGENT_NATIVE_UPDATE_SOCKET', path.join(absoluteRoot, 'x'.repeat(104))],
  ['AGENT_NATIVE_UPDATE_STATE', 'relative-state'],
  ['AGENT_NATIVE_UPDATE_TOKEN', 'a'.repeat(63)],
  ['AGENT_NATIVE_UPDATE_TOKEN', 'a'.repeat(161)],
  ['AGENT_NATIVE_UPDATE_TOKEN', 'a'.repeat(63) + '/'],
  ['AGENT_NATIVE_UPDATE_BUNDLE', 'Relative.app'],
  ['AGENT_NATIVE_UPDATE_BUNDLE', path.join(absoluteRoot, 'wrong-extension')],
  ['AGENT_LAUNCHER_PID', '0'],
  ['AGENT_LAUNCHER_PID', '1.5'],
  ['AGENT_LAUNCHER_PID', 'not-a-process']
])('does not enable an updater with invalid %s', (key, value) => {
  vi.stubEnv(key, value);
  expect(nativeUpdateHostConfiguration()).toBeNull();
  expect(probes.execFile).not.toHaveBeenCalled();
});
it('discovers realpath-bound same-user Sparkle helpers and their transitive descendants, excluding other installations', async () => {
  const framework = path.join(host.bundleRoot, 'Contents/Frameworks/Sparkle.framework');
  const installer = path.join(framework, 'Versions/A/Resources/Installer');
  const exited = path.join(framework, 'exited/Updater');
  const escaped = path.join(framework, 'escape/Downloader');
  const outside = path.join(absoluteRoot, 'Other.app/Updater');
  const paths = new Map([
    [host.bundleRoot, host.bundleRoot],
    [installer, installer],
    [outside, outside],
    [escaped, outside]
  ]);
  probes.realpath.mockImplementation((value: string) => {
    const resolved = paths.get(value);
    if (!resolved) throw Object.assign(new Error('exited'), { code: 'ENOENT' });
    return resolved;
  });
  const stdout = [
    'malformed row',
    '501 500 501 worker-grandchild',
    '500 400 501 worker-child',
    `400 1111 501 ${installer}`,
    `600 400 502 ${installer}`,
    `601 600 502 foreign-worker`,
    `700 1111 501 ${exited}`,
    `701 700 501 child-of-exited`,
    `800 1111 501 ${escaped}`,
    `900 1111 501 ${outside}`,
    '950 1111 501 ordinary-process'
  ].join('\n');
  probes.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback(null, { stdout })
  );
  expect((await nativeUpdateHelperPids(host)).sort((a, b) => a - b)).toEqual([400, 500, 501]);
  expect(probes.execFile).toHaveBeenCalledWith(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,uid=,comm='],
    expect.objectContaining({ maxBuffer: 8 * 1024 * 1024 }),
    expect.any(Function)
  );
});
it('returns no helper discovery on another platform without reading the host process table', async () => {
  platform('win32');
  expect(await nativeUpdateHelperPids(host)).toEqual([]);
  expect(probes.execFile).not.toHaveBeenCalled();
  expect(probes.realpath).not.toHaveBeenCalled();
});
it('propagates failed process discovery instead of treating unknown helper ownership as empty', async () => {
  const failure = Object.assign(new Error('synthetic denied process table'), { code: 'EACCES' });
  probes.execFile.mockImplementation((_command, _args, _options, callback) => callback(failure));
  await expect(nativeUpdateHelperPids(host)).rejects.toBe(failure);
});
