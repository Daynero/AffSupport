// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ family: 'chrome' as string }));
vi.mock('../apps/web/src/lib/browser.js', () => ({
  currentBrowserFamily: () => browser.family,
  browserFamilyFromUserAgent: () => browser.family
}));

import { failureState } from '../apps/web/src/connection.js';
import { connect } from '../apps/web/src/api/client.js';

const TOKEN = 'a'.repeat(64);

describe('what a failed probe means (032 FR-012/FR-016)', () => {
  beforeEach(() => {
    browser.family = 'chrome';
    Object.defineProperty(navigator, 'permissions', {
      value: {
        query: async () => {
          throw new Error('unsupported');
        }
      },
      configurable: true
    });
  });

  it('reads a blocked loopback in Safari on the hosted origin as blocked, not as missing', async () => {
    browser.family = 'safari';
    await expect(failureState({ hosted: true, agentKnown: true })).resolves.toBe(
      'connection_blocked'
    );
  });

  it('keeps "not running" when the agent has never been seen, whatever the browser', async () => {
    browser.family = 'safari';
    await expect(failureState({ hosted: true, agentKnown: false })).resolves.toBe(
      'not_installed_or_not_running'
    );
  });

  it('never calls the local copy blocked: the page itself came from the agent', async () => {
    browser.family = 'safari';
    await expect(failureState({ hosted: false, agentKnown: true })).resolves.toBe(
      'not_installed_or_not_running'
    );
  });

  it('still honours a denied Chrome local-network permission', async () => {
    Object.defineProperty(navigator, 'permissions', {
      value: { query: async () => ({ state: 'denied' }) },
      configurable: true
    });
    await expect(failureState()).resolves.toBe('connection_blocked');
  });
});

describe('a health answer without a protocol version (032 FR-014)', () => {
  beforeEach(() => {
    localStorage.setItem('agentToken', TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is a connection failure, not an old agent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    await expect(connect()).rejects.toThrow('CONNECTION_FAILED');
  });

  it('passes the heartbeat period through when the agent states one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/health')
          ? new Response(
              JSON.stringify({
                version: '1.2.5',
                apiVersion: 5,
                capabilities: ['event-stream'],
                heartbeatMs: 15000
              }),
              { status: 200 }
            )
          : new Response(JSON.stringify({ jobs: [], revision: 1 }), { status: 200 })
      )
    );
    const result = await connect();
    expect(result.heartbeatMs).toBe(15000);
    expect(result.apiVersion).toBe(5);
  });
});
