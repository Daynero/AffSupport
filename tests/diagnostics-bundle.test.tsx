// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const analyticsTrack = vi.hoisted(() => vi.fn());
const fetchAgentDiagnostics = vi.hoisted(() => vi.fn());
const agentState = vi.hoisted(() => ({
  value: {
    connection: 'connected',
    reason: null,
    lastKnownAgent: {
      version: '1.4.2',
      buildId: '2026.10.09.1',
      instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channel: 'stable',
      capabilities: ['landing', 'unified-stream'],
      toolContracts: {},
      seenAt: 1_700_000_000_000
    }
  } as unknown
}));

vi.mock('../apps/web/src/api/client', () => ({ fetchAgentDiagnostics }));
vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: { track: analyticsTrack, setLocale: vi.fn() }
}));
vi.mock('../apps/web/src/analytics/link', () => ({ linkOrigin: () => 'hosted' }));
vi.mock('../apps/web/src/AgentContext', () => ({
  useOptionalAgent: () => agentState.value
}));

import { DiagnosticsBundle } from '../apps/web/src/support/DiagnosticsBundle';
import {
  buildDiagnosticsBundle,
  sanitizeDiagnosticsBundle
} from '../apps/web/src/support/diagnostics-bundle';

const journal = {
  environment: 'production',
  version: '1.4.2',
  buildNumber: '412',
  buildId: '2026.10.09.1',
  instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  apiVersion: 7,
  channel: 'stable',
  startedAt: 1_700_000_000_000,
  system: 'darwin 25.6.0',
  architecture: 'arm64',
  log: [
    { seq: 1, at: 1_700_000_001_000, category: 'boot', code: 'agent_started' },
    {
      seq: 2,
      at: 1_700_000_002_000,
      category: 'spawn',
      code: 'child_exited',
      props: { tool: 'ffmpeg', exit: 0, duration_bucket: 'under_10s' }
    }
  ],
  nextSeq: 2,
  logRejected: 1
};

const fetchSpy = vi.fn();

beforeEach(() => {
  localStorage.setItem('language', 'en');
  analyticsTrack.mockReset();
  fetchAgentDiagnostics.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined
  });
}

async function collect() {
  fireEvent.click(screen.getByRole('button', { name: 'Collect diagnostics' }));
  const output = await screen.findByTestId('diagnostics-bundle-output');
  return output.textContent ?? '';
}

describe('DiagnosticsBundle', () => {
  it('renders the collect button and asks the agent for the last 200 records', async () => {
    fetchAgentDiagnostics.mockResolvedValue(journal);
    render(<DiagnosticsBundle />);

    expect(screen.getByRole('button', { name: 'Collect diagnostics' })).toBeTruthy();
    expect(screen.queryByTestId('diagnostics-bundle-output')).toBeNull();

    const shown = await collect();
    const bundle = JSON.parse(shown);

    expect(fetchAgentDiagnostics).toHaveBeenCalledTimes(1);
    expect(fetchAgentDiagnostics).toHaveBeenCalledWith(0, 200);
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(bundle.agent.log).toHaveLength(2);
    expect(bundle.agent.log[1].code).toBe('child_exited');
    expect(bundle.agent.log[1].props.exit).toBe(0);
    expect(bundle.agent.version).toBe('1.4.2');
    expect(bundle.agent.environment).toBe('production');
    expect(bundle.agent.platform).toBe('darwin 25.6.0');
    expect(bundle.agent.capabilities).toBe(2);
    expect(bundle.agent.logRejected).toBe(1);
    expect(bundle.web.browserFamily).toBeTypeOf('string');
    expect(bundle.web.origin).toBe('hosted');
    expect(bundle.web.connection).toBe('connected');
    expect(bundle.web.lastKnownAgent).toEqual({
      version: '1.4.2',
      buildId: '2026.10.09.1',
      instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channel: 'stable'
    });
    expect(bundle.recentLinkEvents).toEqual([]);
    expect(typeof bundle.generatedAt).toBe('string');

    expect(screen.getByText(/^2 records from the local app/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(analyticsTrack).not.toHaveBeenCalled();
  });

  it('still builds the bundle when the agent is unreachable', async () => {
    fetchAgentDiagnostics.mockRejectedValue(new Error('CONNECTION_FAILED'));
    agentState.value = {
      connection: 'not_installed_or_not_running',
      reason: 'not_running',
      lastKnownAgent: null
    };
    render(<DiagnosticsBundle />);

    const shown = await collect();
    const bundle = JSON.parse(shown);

    expect(bundle.agent).toBe('unavailable');
    expect(bundle.web.connection).toBe('not_installed_or_not_running');
    expect(bundle.web.reason).toBe('not_running');
    expect(bundle.web.lastKnownAgent).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('The local app did not answer');
    expect(screen.getByText(/^0 records from the local app/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();

    agentState.value = {
      connection: 'connected',
      reason: null,
      lastKnownAgent: {
        version: '1.4.2',
        buildId: '2026.10.09.1',
        instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        channel: 'stable',
        capabilities: ['landing', 'unified-stream'],
        toolContracts: {},
        seenAt: 1_700_000_000_000
      }
    };
  });

  it('drops planted paths, tokens, urls, addresses and forbidden keys before showing anything', async () => {
    fetchAgentDiagnostics.mockResolvedValue({
      ...journal,
      buildId: 'release/2026.10.09',
      log: [
        ...journal.log,
        {
          seq: 3,
          at: 1_700_000_003_000,
          category: 'picker',
          code: 'picker_exit',
          props: {
            file: '/Users/dayne/Movies/secret-clip.mp4',
            windows: 'C:\\Users\\dayne\\clip.mp4',
            link: 'https://example.com/clip',
            who: 'dayne@example.com',
            auth: 'Bearer abcdef',
            session: 'token=abcdef',
            long: 'x'.repeat(121),
            token: 'safe-looking-value',
            path: 'also-safe',
            url: 'safe',
            name: 'clip',
            secret: 'hunter2',
            cookie: 'sid',
            authorization: 'basic',
            bucket: 'under_10s',
            exit: 1,
            cancelled: true
          }
        }
      ]
    });
    render(<DiagnosticsBundle />);

    const shown = await collect();

    for (const planted of [
      '/Users/',
      'secret-clip',
      'C:\\\\Users',
      'https://',
      'example.com',
      '@',
      'Bearer',
      'token',
      'hunter2',
      '"path"',
      '"url"',
      '"name"',
      '"secret"',
      '"cookie"',
      '"authorization"',
      'release/2026'
    ]) {
      expect(shown, `bundle must not contain ${planted}`).not.toContain(planted);
    }
    expect(shown).not.toContain('x'.repeat(121));

    const bundle = JSON.parse(shown);
    const planted = bundle.agent.log[2];
    expect(planted.code).toBe('picker_exit');
    expect(planted.props).toEqual({ bucket: 'under_10s', exit: 1, cancelled: true });
    expect(bundle.agent.buildId).toBeUndefined();
    expect(bundle.agent.log).toHaveLength(3);
  });

  it('copies exactly the shown text and reports the copy once', async () => {
    fetchAgentDiagnostics.mockResolvedValue(journal);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<DiagnosticsBundle />);

    const shown = await collect();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(shown);
    expect(analyticsTrack).toHaveBeenCalledTimes(1);
    expect(analyticsTrack).toHaveBeenCalledWith('diagnostics_copied', {
      action_identifier: 'copy_bundle'
    });
    expect(fetchAgentDiagnostics).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    stubClipboard(undefined);
  });

  it('falls back to the selection command when the async clipboard is missing', async () => {
    fetchAgentDiagnostics.mockResolvedValue(journal);
    stubClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    render(<DiagnosticsBundle />);

    await collect();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('.diagnostics-bundle-clipboard')).toBeNull();
    expect(analyticsTrack).toHaveBeenCalledTimes(1);
  });
});

describe('sanitizeDiagnosticsBundle', () => {
  it('keeps numbers, booleans, nulls and safe strings and preserves shape', () => {
    expect(
      sanitizeDiagnosticsBundle({
        count: 3,
        flag: false,
        nothing: null,
        code: 'child_exited',
        nested: { bucket: 'under_10s', list: ['ok', '/no', 'fine', 'a@b', 'x'.repeat(121)] }
      })
    ).toEqual({
      count: 3,
      flag: false,
      nothing: null,
      code: 'child_exited',
      nested: { bucket: 'under_10s', list: ['ok', 'fine'] }
    });
  });

  it('refuses strings with separators, schemes, addresses, credentials or length', () => {
    expect(sanitizeDiagnosticsBundle('a/b')).toBeNull();
    expect(sanitizeDiagnosticsBundle('a\\b')).toBeNull();
    expect(sanitizeDiagnosticsBundle('https://x')).toBeNull();
    expect(sanitizeDiagnosticsBundle('me@x')).toBeNull();
    expect(sanitizeDiagnosticsBundle('Token')).toBeNull();
    expect(sanitizeDiagnosticsBundle('BEARER')).toBeNull();
    expect(sanitizeDiagnosticsBundle('x'.repeat(121))).toBeNull();
    expect(sanitizeDiagnosticsBundle('x'.repeat(120))).toBe('x'.repeat(120));
    expect(sanitizeDiagnosticsBundle(Number.NaN)).toBeNull();
    expect(sanitizeDiagnosticsBundle(() => 1)).toBeNull();
  });

  it('drops keys named like credentials, paths, names or urls whatever they hold', () => {
    expect(
      sanitizeDiagnosticsBundle({
        accessToken: 1,
        Secret: 2,
        cookie: 3,
        authorization: 4,
        filePath: 5,
        fileName: 6,
        imageUrl: 7,
        kept: 8
      })
    ).toEqual({ kept: 8 });
  });

  it('builds an unavailable agent section without a response and caps the log at 200', () => {
    const log = Array.from({ length: 250 }, (_, index) => ({
      seq: index + 1,
      at: index,
      category: 'stream' as const,
      code: 'subscribe'
    }));
    const web = {
      browserFamily: 'chrome' as const,
      origin: 'hosted' as const,
      connection: 'connected',
      reason: null,
      lastKnownAgent: null
    };
    const unavailable = buildDiagnosticsBundle({ agent: null, web });
    expect(unavailable.agent).toBe('unavailable');
    const full = buildDiagnosticsBundle({ agent: { log }, web });
    expect(full.agent).not.toBe('unavailable');
    if (full.agent !== 'unavailable') {
      expect(full.agent.log).toHaveLength(200);
      expect(full.agent.log[0].seq).toBe(51);
    }
  });
});
