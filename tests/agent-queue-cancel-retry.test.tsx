// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cancelUntilHeard } from '../apps/web/src/team/explorer/useAgentQueue';
import { TeamApiError } from '../apps/web/src/api/team';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('telling the space a failed run is over (production 2026-11-26)', () => {
  it('keeps sending while the network is down, then stops', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({});
    await cancelUntilHeard(send, [1, 1, 1, 1], () => Promise.resolve());
    for (let i = 0; i < 5; i += 1) await flush();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('takes a final refusal as heard', async () => {
    const send = vi.fn().mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false));
    await cancelUntilHeard(send, [1, 1], () => Promise.resolve());
    for (let i = 0; i < 5; i += 1) await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up after its budget', async () => {
    const send = vi.fn().mockRejectedValue(new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true));
    await cancelUntilHeard(send, [1, 1], () => Promise.resolve());
    for (let i = 0; i < 5; i += 1) await flush();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
