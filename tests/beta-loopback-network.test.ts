import { expect, it, vi } from 'vitest';
import {
  localDockerEndpoint,
  prepareBetaLoopbackNetwork,
  verifyBetaLoopbackBindings
} from '../scripts/lib/beta-loopback-network.mjs';
const project = 'acceptance036',
  name = 'soty-beta-acceptance036-loopback',
  id = 'a'.repeat(12);
function fixture(
  options: {
    remote?: boolean;
    existing?: boolean;
    borrowed?: boolean;
    wildcard?: boolean;
    foreignNetwork?: boolean;
    wrongOwner?: boolean;
    daemonFails?: boolean;
  } = {}
) {
  const network = {
    Name: name,
    Driver: 'bridge',
    Scope: 'local',
    Internal: false,
    Ingress: false,
    EnableIPv6: false,
    Options: { 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' },
    Labels: {
      'com.soty.beta.loopback': 'v1',
      'com.soty.beta.project': options.wrongOwner ? 'other' : project
    },
    Containers: {}
  };
  let running = options.borrowed ?? false;
  const docker = vi.fn((args: string[]) => {
    let result = '';
    if (args[0] === 'context' && args[1] === 'show') result = 'colima';
    else if (args[0] === 'context')
      result = JSON.stringify(options.remote ? 'ssh://remote.example' : 'unix:///tmp/docker.sock');
    else if (args[0] === 'ps') result = running ? id : '';
    else if (args[0] === 'network' && args[1] === 'ls') result = options.existing ? name : '';
    else if (args[0] === 'network' && args[1] === 'inspect') result = JSON.stringify([network]);
    else if (args[0] === 'inspect')
      result = JSON.stringify({
        Networks: { [options.foreignNetwork ? 'other' : name]: {} },
        Ports: {
          '5432/tcp': [{ HostIp: options.wildcard ? '0.0.0.0' : '127.0.0.1', HostPort: '54322' }]
        }
      });
    return { status: options.daemonFails ? 1 : 0, stdout: result };
  });
  return {
    docker,
    start: () => {
      running = true;
    }
  };
}
it('creates a project-owned loopback bridge and verifies effective bindings', () => {
  const f = fixture();
  expect(prepareBetaLoopbackNetwork(project, f.docker, {})).toEqual({ name, created: true });
  expect(f.docker).toHaveBeenCalledWith(
    expect.arrayContaining(['com.docker.network.bridge.host_binding_ipv4=127.0.0.1'])
  );
  f.start();
  expect(verifyBetaLoopbackBindings(project, name, f.docker)).toEqual({
    containers: 1,
    publishedBindings: 1,
    loopbackOnly: true
  });
});
it('reuses only an empty matching owned bridge', () => {
  const f = fixture({ existing: true });
  expect(prepareBetaLoopbackNetwork(project, f.docker, {}).created).toBe(false);
  expect(f.docker.mock.calls.some(([args]) => args[0] === 'network' && args[1] === 'create')).toBe(
    false
  );
});
it.each(['remote', 'borrowed', 'wrongOwner', 'daemonFails'] as const)(
  'refuses %s before stack startup',
  fault => {
    const f = fixture({ existing: true, [fault]: true });
    expect(() => prepareBetaLoopbackNetwork(project, f.docker, {})).toThrow(
      'BETA_LOOPBACK_NETWORK_REFUSED'
    );
  }
);
it.each(['wildcard', 'foreignNetwork'] as const)('does not accept %s after startup', fault => {
  const f = fixture({ [fault]: true });
  f.start();
  expect(() => verifyBetaLoopbackBindings(project, name, f.docker)).toThrow(
    'BETA_LOOPBACK_NETWORK_REFUSED'
  );
});
it.each(['tcp://remote.example:2375', 'ssh://host', 'npipe://remote/pipe/docker', ''])(
  'rejects nonlocal Docker endpoint %s',
  endpoint => expect(localDockerEndpoint(endpoint)).toBe(false)
);
it.each([
  'unix:///var/run/docker.sock',
  'npipe:////./pipe/docker_engine',
  'tcp://127.0.0.1:2375',
  'tcp://[::1]:2375'
])('accepts local Docker endpoint %s', endpoint =>
  expect(localDockerEndpoint(endpoint)).toBe(true)
);
