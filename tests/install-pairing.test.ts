// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentInstallAwaitingPairing,
  agentKnown,
  agentLocalUrl,
  consumePairingToken,
  markAgentInstallStarted,
  markAgentSeen
} from '../apps/web/src/api/client';

const TOKEN = 'a'.repeat(64);

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

  it('still counts a download from yesterday morning as an installation in progress', () => {
    // An unsigned build means an unzip, an OS warning and a first launch, and
    // the tab that started the download is often closed along the way.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00Z'));
    markAgentInstallStarted();
    vi.setSystemTime(new Date('2026-07-21T11:00:00Z'));

    expect(agentInstallAwaitingPairing()).toBe(true);
  });

  it('expires an abandoned installation handoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00Z'));
    markAgentInstallStarted();
    vi.setSystemTime(new Date('2026-07-21T13:00:00Z'));

    expect(agentInstallAwaitingPairing()).toBe(false);
  });

  it('clears the handoff once the agent token returns to the tab', () => {
    markAgentInstallStarted();
    history.replaceState(null, '', `/#agentToken=${TOKEN}`);

    consumePairingToken();

    expect(agentInstallAwaitingPairing()).toBe(false);
    expect(location.hash).toBe('');
  });
});

describe('knowing that Soty is on this computer', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState(null, '', '/');
    vi.useRealTimers();
  });

  it('assumes nothing about a browser that has never met the Agent', async () => {
    // A fresh module: the token is cached in a module-level variable that
    // outlives `localStorage.clear()`, exactly as it outlives a re-render in
    // the browser.
    vi.resetModules();
    const fresh = await import('../apps/web/src/api/pairing-token');

    expect(fresh.agentKnown()).toBe(false);
  });

  it('remembers the Agent for good once it has answered', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00Z'));
    markAgentSeen();
    // Long past any installation window: the browsers that refuse to reach
    // loopback refuse every time, so an expiring answer would send the same
    // person back to the download button a week later.
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));

    expect(agentKnown()).toBe(true);
  });

  it('treats a pairing token that arrived from the Agent as proof', () => {
    history.replaceState(null, '', `/#agentToken=${TOKEN}`);
    consumePairingToken();

    expect(agentKnown()).toBe(true);
  });

  it('counts an installation that is still in progress', () => {
    markAgentInstallStarted();

    expect(agentKnown()).toBe(true);
  });
});

describe('the link to the copy the Agent serves', () => {
  it('carries the page the user was trying to reach', () => {
    expect(agentLocalUrl('/tools/transcription')).toBe(
      'http://127.0.0.1:43120/local?to=%2Ftools%2Ftranscription'
    );
  });

  it('keeps a query string, which is where a tool preselection lives', () => {
    expect(agentLocalUrl('/tools/compressor?tab=queue')).toBe(
      'http://127.0.0.1:43120/local?to=%2Ftools%2Fcompressor%3Ftab%3Dqueue'
    );
  });

  it('asks for nothing in particular when the user is already on the home page', () => {
    expect(agentLocalUrl('/')).toBe('http://127.0.0.1:43120/local');
  });

  it.each(['//evil.example', 'https://evil.example/x', 'tools/compressor', '/x#y'])(
    'refuses to forward %s',
    candidate => {
      expect(agentLocalUrl(candidate)).toBe('http://127.0.0.1:43120/local');
    }
  );
});
