import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilities, nativeUpdateHostConfiguration } from '../apps/agent/src/platform/platform';
import { advertisedCapabilities } from '../apps/agent/src/server/capabilities';
afterEach(() => vi.unstubAllEnvs());
describe('native update host capability', () => {
  it('does not advertise from macOS support alone', () => {
    expect(advertisedCapabilities({ ...capabilities(), nativeAppUpdates: false })).not.toContain(
      'native-app-updates-v1'
    );
    expect(advertisedCapabilities({ ...capabilities(), nativeAppUpdates: true })).toContain(
      'native-app-updates-v1'
    );
  });
  it('does not accept a dev or unconfigured host', () => {
    vi.stubEnv('PACKAGED_APP', '0');
    vi.stubEnv('AGENT_NATIVE_UPDATES', '1');
    expect(nativeUpdateHostConfiguration()).toBe(null);
    vi.stubEnv('PACKAGED_APP', '1');
    vi.stubEnv('AGENT_NATIVE_UPDATE_SOCKET', 'relative.sock');
    expect(nativeUpdateHostConfiguration()).toBe(null);
  });
});
