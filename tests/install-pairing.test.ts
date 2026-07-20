// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentInstallAwaitingPairing,
  consumePairingToken,
  markAgentInstallStarted
} from '../apps/web/src/api/client';

describe('agent installation pairing handoff', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState(null, '', '/');
    vi.useRealTimers();
  });

  it('keeps the initiating browser tab eligible for automatic pairing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00Z'));
    markAgentInstallStarted();

    expect(agentInstallAwaitingPairing()).toBe(true);
  });

  it('expires an abandoned installation handoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00Z'));
    markAgentInstallStarted();
    vi.setSystemTime(new Date('2026-07-20T12:16:00Z'));

    expect(agentInstallAwaitingPairing()).toBe(false);
  });

  it('clears the handoff once the agent token returns to the tab', () => {
    markAgentInstallStarted();
    history.replaceState(null, '', `/#agentToken=${'a'.repeat(64)}`);

    consumePairingToken();

    expect(agentInstallAwaitingPairing()).toBe(false);
    expect(location.hash).toBe('');
  });
});
