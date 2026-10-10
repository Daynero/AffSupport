// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real `AgentProvider`, with the local app, the shared stream and the account check
 * played by hand. What is under test is the owner of the connection state: that a lost
 * stream becomes `disconnected`, that a recovered one is believed only after health and
 * the snapshot were re-read, that a rejected token re-pairs in place, and that an attempt
 * can neither hang nor swallow a second press (032 US1, US2).
 */
const fake = vi.hoisted(() => {
  type Connect = () => Promise<unknown>;
  const state = {
    connect: (async () => {
      throw new Error('CONNECTION_FAILED');
    }) as Connect,
    connectCalls: 0,
    handshake: (async () => null) as () => Promise<string | null>,
    entitlement: (async () => ({
      enforced: true,
      entitled: true,
      reason: 'active'
    })) as () => Promise<unknown>,
    stream: {
      watchers: [] as Array<(status: { open: boolean; reason?: string }) => void>,
      configured: [] as Array<unknown>,
      restarts: 0,
      open: false
    },
    pairing: {
      listeners: [] as Array<() => void>,
      token: 'a'.repeat(64)
    },
    requestFailures: [] as Array<(kind: string) => void>,
    pairingBudget: 2
  };
  return state;
});

vi.mock('../apps/web/src/api/client.js', () => ({
  agentUrl: 'http://127.0.0.1:43120',
  agentInstallAwaitingPairing: () => false,
  agentKnown: () => true,
  agentProvenAlive: (error: unknown) => Boolean((error as { agentAlive?: boolean })?.agentAlive),
  markAgentSeen: () => {},
  claimAutomaticPairing: () => {
    fake.pairingBudget -= 1;
    return fake.pairingBudget >= 0;
  },
  releaseAutomaticPairing: () => {},
  pairWithAgent: () => {},
  toolEventUrl: () => 'http://127.0.0.1:43120/api/events?token=x',
  connect: () => {
    fake.connectCalls += 1;
    return fake.connect();
  },
  onRequestFailure: (listener: (kind: string) => void) => {
    fake.requestFailures.push(listener);
    return () => {};
  },
  onPairingToken: (listener: () => void) => {
    fake.pairing.listeners.push(listener);
    return () => {};
  }
}));

vi.mock('../apps/web/src/api/pairing-token.js', () => ({
  handshakeForToken: () => fake.handshake(),
  hasPendingPairingToken: () => false,
  pairingToken: () => fake.pairing.token,
  storePairingToken: (value: string) => {
    const changed = value !== fake.pairing.token;
    fake.pairing.token = value;
    if (changed) for (const listener of fake.pairing.listeners) listener();
    return changed;
  },
  verifyPairingToken: async () => false,
  onPairingToken: (listener: () => void) => {
    fake.pairing.listeners.push(listener);
    return () => {};
  }
}));

vi.mock('../apps/web/src/api/stream-client.js', () => ({
  DEFAULT_HEARTBEAT_MS: 15000,
  streamClient: {
    configure: (config: unknown) => fake.stream.configured.push(config),
    subscribe: () => () => {},
    watchConnection: (listener: (status: { open: boolean; reason?: string }) => void) => {
      fake.stream.watchers.push(listener);
      return () => {};
    },
    restart: () => {
      fake.stream.restarts += 1;
    },
    isOpen: () => fake.stream.open
  }
}));

vi.mock('../apps/web/src/api/entitlement.js', () => ({
  ensureAgentEntitlement: () => fake.entitlement()
}));

vi.mock('../apps/web/src/release-manifest.js', () => ({
  loadStableReleaseManifest: async () => null,
  installedReleaseStatus: () => 'unknown'
}));

import { AgentProvider, useAgent } from '../apps/web/src/AgentContext.js';
import { analytics } from '../apps/web/src/analytics/service.js';

class PairingRequired extends Error {
  readonly agentAlive = true;
  constructor() {
    super('PAIRING_REQUIRED');
  }
}

function healthy(overrides: Record<string, unknown> = {}) {
  return {
    state: { jobs: [], running: false, revision: 7 },
    version: '1.2.5',
    buildId: 'b1',
    instanceId: 'run-1',
    platform: 'macos',
    channel: 'stable',
    apiVersion: 5,
    capabilities: ['event-stream'],
    toolContracts: { compressor: 1 },
    entitlement: { enforced: true, entitled: true, reason: 'active' },
    heartbeatMs: 15000,
    update: null,
    ...overrides
  };
}

function Probe() {
  const agent = useAgent();
  return (
    <div>
      <span data-testid="connection">{agent.connection}</span>
      <span data-testid="reason">{agent.reason ?? 'none'}</span>
      <span data-testid="attempt">
        {agent.attempt
          ? `${agent.attempt.trigger}:${agent.attempt.joined ? 'joined' : 'solo'}`
          : 'idle'}
      </span>
      <span data-testid="revision">{agent.state.revision ?? 0}</span>
      <span data-testid="instance">{agent.lastKnownAgent?.instanceId ?? 'none'}</span>
      <span data-testid="account">{agent.accountCheckPending ? 'pending' : 'ok'}</span>
      <button onClick={() => agent.reconnect('team_shell')}>reconnect</button>
    </div>
  );
}

const streamStatus = (status: { open: boolean; reason?: string }) => {
  fake.stream.open = status.open;
  for (const watcher of fake.stream.watchers) watcher(status);
};

const text = (id: string) => screen.getByTestId(id).textContent;

describe('the owner of the connection state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.connectCalls = 0;
    fake.connect = async () => healthy();
    fake.handshake = async () => null;
    fake.entitlement = async () => ({ enforced: true, entitled: true, reason: 'active' });
    fake.stream.watchers.length = 0;
    fake.stream.configured.length = 0;
    fake.stream.restarts = 0;
    fake.stream.open = false;
    fake.pairing.listeners.length = 0;
    fake.pairing.token = 'a'.repeat(64);
    fake.requestFailures.length = 0;
    fake.pairingBudget = 2;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function boot() {
    render(
      <AgentProvider>
        <Probe />
      </AgentProvider>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(text('connection')).toBe('connected');
    streamStatus({ open: true });
  }

  it('gives analytics the agent instance and its own platform after a health read (031 FR-053)', async () => {
    const setAgentContext = vi.spyOn(analytics, 'setAgentContext');
    try {
      await boot();
      expect(setAgentContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ instanceId: 'run-1', platform: 'macos', version: '1.2.5' })
      );
    } finally {
      setAgentContext.mockRestore();
    }
  });

  it('places an agent without a platform field by its capabilities, or not at all', async () => {
    const setAgentContext = vi.spyOn(analytics, 'setAgentContext');
    try {
      fake.connect = async () =>
        healthy({ platform: undefined, capabilities: ['event-stream', 'finder-image-conversion'] });
      await boot();
      expect(setAgentContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ instanceId: 'run-1', platform: 'macos' })
      );
      cleanup();
      setAgentContext.mockClear();
      fake.connect = async () => healthy({ platform: undefined });
      await boot();
      expect(setAgentContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ instanceId: 'run-1', platform: null })
      );
    } finally {
      setAgentContext.mockRestore();
    }
  });

  it('hands the stream a token it reads at every connection', async () => {
    await boot();
    const config = fake.stream.configured.at(-1) as { token: () => string; heartbeatMs: number };
    expect(typeof config.token).toBe('function');
    expect(config.token()).toBe('a'.repeat(64));
    expect(config.heartbeatMs).toBe(15000);
  });

  it('notices a lost stream after the grace, and believes a recovery only after re-reading', async () => {
    await boot();
    fake.connect = async () => {
      throw new Error('CONNECTION_FAILED');
    };
    await act(async () => {
      streamStatus({ open: false, reason: 'network' });
      await vi.advanceTimersByTimeAsync(2_000);
    });
    // Inside the grace nothing is said: a wifi handover is not a lost application.
    expect(text('connection')).toBe('connected');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(text('connection')).toBe('disconnected');
    expect(text('reason')).toBe('not_running');

    // The stream client reconnects on its own and reports open; that alone does not make
    // the page "connected" — a socket against a process with a different token or
    // entitlement would look exactly the same. Health and the snapshot decide.
    await act(async () => {
      streamStatus({ open: true });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(text('connection')).toBe('disconnected');

    fake.connect = async () => healthy({ instanceId: 'run-2', state: { jobs: [], revision: 1 } });
    // The grace (3 s) and then the first retry (4 s): the next check lands healthy.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(text('connection')).toBe('connected');
    expect(text('reason')).toBe('none');
    // A restarted local app counts from zero: its lower revision is the newer snapshot.
    expect(text('revision')).toBe('1');
    expect(text('instance')).toBe('run-2');
  });

  it('re-pairs in place when the stream is refused for its token, then restarts the stream', async () => {
    await boot();
    fake.connect = async () => {
      throw new PairingRequired();
    };
    // The local app minted a new token; once the handshake has delivered it, the
    // app answers again.
    fake.handshake = async () => {
      fake.connect = async () => healthy({ instanceId: 'run-3' });
      return 'b'.repeat(64);
    };
    await act(async () => {
      streamStatus({ open: false, reason: 'unauthorized' });
      await vi.advanceTimersByTimeAsync(10);
    });
    // Storing the token notifies the listener, which restarts the stream and
    // re-establishes against the new token — in place, with no navigation.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fake.pairing.token).toBe('b'.repeat(64));
    expect(fake.stream.restarts).toBeGreaterThanOrEqual(1);
    expect(text('connection')).toBe('connected');
    expect(text('instance')).toBe('run-3');
  });

  it('never lets an attempt hang, and lets a second press join the first', async () => {
    fake.connect = () => new Promise(() => {});
    render(
      <AgentProvider>
        <Probe />
      </AgentProvider>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(text('attempt')).toBe('boot:solo');
    await act(async () => {
      screen.getByText('reconnect').click();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(text('attempt')).toBe('boot:joined');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    expect(text('attempt')).toBe('idle');
    expect(text('reason')).toBe('timeout');
    // And the next press starts a fresh attempt instead of being swallowed.
    fake.connect = async () => healthy();
    await act(async () => {
      screen.getByText('reconnect').click();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(text('connection')).toBe('connected');
  });

  it('treats an unreachable account check as pending with a slow retry, not as a verdict', async () => {
    fake.connect = async () =>
      healthy({ entitlement: { enforced: true, entitled: false, reason: 'expired' } });
    fake.entitlement = async () => {
      throw new Error('ENTITLEMENT_UNAVAILABLE');
    };
    render(
      <AgentProvider>
        <Probe />
      </AgentProvider>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(text('connection')).toBe('entitlement_blocked');
    expect(text('reason')).toBe('account_check_unavailable');
    const calls = fake.connectCalls;
    fake.entitlement = async () => ({ enforced: true, entitled: true, reason: 'active' });
    fake.connect = async () => healthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100);
    });
    expect(fake.connectCalls).toBeGreaterThan(calls);
    expect(text('connection')).toBe('connected');
  });

  it('re-checks when a request is refused while the page believes it is connected', async () => {
    await boot();
    const calls = fake.connectCalls;
    fake.connect = async () => healthy({ instanceId: 'run-4' });
    await act(async () => {
      for (const listener of fake.requestFailures) listener('connection_failed');
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(fake.connectCalls).toBe(calls + 1);
    expect(text('instance')).toBe('run-4');
  });

  it('checks the link when the tab comes back, but not when it is already live', async () => {
    await boot();
    const calls = fake.connectCalls;
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
      await vi.advanceTimersByTimeAsync(600);
    });
    // Connected with an open stream: nothing to do.
    expect(fake.connectCalls).toBe(calls);

    fake.stream.open = false;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fake.connectCalls).toBe(calls + 1);
  });
});
