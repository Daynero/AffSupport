// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { imageContentUrl, onRequestFailure } from '../apps/web/src/api/client';
import { clearSubresourceTickets } from '../apps/web/src/api/subresource-paths';

afterEach(() => {
  clearSubresourceTickets();
  vi.unstubAllGlobals();
});

it.each([
  { status: 401, kind: 'unauthorized' },
  { status: 403, kind: 'forbidden' },
  { status: 0, kind: 'connection_failed' }
])(
  'delivers a ticket $kind through the public client observer used by AgentProvider',
  async ({ status, kind }) => {
    clearSubresourceTickets();
    const fetcher = status
      ? vi.fn().mockResolvedValue(new Response(null, { status }))
      : vi.fn().mockRejectedValue(new Error('synthetic private transport detail'));
    vi.stubGlobal('fetch', fetcher);
    const observed = vi.fn();
    const stop = onRequestFailure(observed);
    try {
      expect(await imageContentUrl('synthetic-private-resource')).toBeNull();
      expect(observed.mock.calls).toEqual([[kind]]);
      expect(JSON.stringify(observed.mock.calls)).not.toMatch(/private|resource|token|http/);
    } finally {
      stop();
    }
  }
);
