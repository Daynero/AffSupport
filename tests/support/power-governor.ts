import { afterEach, vi } from 'vitest';
import { PowerGovernor, type PowerGovernorOptions } from '../../apps/agent/src/power/governor.js';

const governors = new Set<PowerGovernor>();

/** Fake child PIDs must never discover or signal the host's real descendants. */
export function testPowerGovernor(options: PowerGovernorOptions = {}): PowerGovernor {
  const governor = new PowerGovernor({
    probeProcessTable: async () => [],
    descendantSignals: {
      pause: vi.fn(() => true),
      resume: vi.fn(() => true),
      setPriority: vi.fn()
    },
    ...options
  });
  governors.add(governor);
  return governor;
}

afterEach(async () => {
  for (const governor of governors) await governor.shutdown();
  governors.clear();
});
