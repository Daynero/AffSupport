import { describe, expect, it, vi } from 'vitest';
import {
  agentFetchOptions,
  MAX_SUPPORTED_API_VERSION,
  MIN_SUPPORTED_API_VERSION,
  pairingPath,
  probeAgent,
  versionState
} from '../apps/web/src/connection';

describe('agent compatibility', () => {
  it('accepts every API version in the declared compatibility range', () => {
    expect(versionState(MIN_SUPPORTED_API_VERSION)).toBe('connected');
    expect(versionState(MAX_SUPPORTED_API_VERSION)).toBe('connected');
  });
  it('distinguishes an old agent from a web client that is too old', () => {
    expect(versionState(0)).toBe('agent_update_required');
    expect(versionState(Number.NaN)).toBe('agent_update_required');
    expect(versionState(MIN_SUPPORTED_API_VERSION - 1)).toBe('agent_update_required');
    expect(versionState(MAX_SUPPORTED_API_VERSION + 1)).toBe('web_update_required');
  });
  it('pairs hosted pages through the production redirect and local pages locally', () => {
    expect(
      pairingPath('http://127.0.0.1:43120', 'https://local-video-compressor-test.pages.dev')
    ).toBe('/pair');
    expect(pairingPath('http://127.0.0.1:43120', 'http://127.0.0.1:43120')).toBe('/local');
  });
  it('lets browsers classify the loopback Agent instead of mislabeling it as local', () => {
    expect(
      agentFetchOptions('http://127.0.0.1:43120', 'https://local-video-compressor-test.pages.dev')
    ).toEqual({});
    expect(
      agentFetchOptions('http://localhost:43120', 'https://local-video-compressor-test.pages.dev')
    ).toEqual({});
    expect(
      agentFetchOptions('http://[::1]:43120', 'https://local-video-compressor-test.pages.dev')
    ).toEqual({});
  });

  it('refuses to start pairing when the local Agent is unreachable', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Connection refused'));
    await expect(
      probeAgent(
        'http://127.0.0.1:43120',
        'https://local-video-compressor-test.pages.dev',
        undefined,
        fetcher
      )
    ).rejects.toThrow('CONNECTION_FAILED');
  });

  it('allows pairing only after the Agent health endpoint answers', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ product: 'local-video-compressor-agent', ready: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    await expect(
      probeAgent(
        'http://127.0.0.1:43120',
        'https://local-video-compressor-test.pages.dev',
        undefined,
        fetcher
      )
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:43120/health',
      expect.objectContaining({ method: 'GET', cache: 'no-store' })
    );
  });

  it('does not trust an unrelated service on the Agent port', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    await expect(
      probeAgent(
        'http://127.0.0.1:43120',
        'https://local-video-compressor-test.pages.dev',
        undefined,
        fetcher
      )
    ).rejects.toThrow('CONNECTION_FAILED');
  });
});
