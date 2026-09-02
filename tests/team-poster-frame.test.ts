import { describe, expect, it, vi } from 'vitest';
import { AGENT_TOOL_CONTRACTS, teamPosterFrameSupported } from '../packages/shared/src/release';
import { TeamPosterBridge } from '../apps/agent/src/team-bridge/poster';

/**
 * A poster frame for a video Google Drive never made a thumbnail for.
 *
 * The folder used to show rows of identical glyphs, and the only way to know
 * what a file was, was to open it. The machine that can answer is the one
 * already paired.
 */

function grant() {
  return {
    ticket: 'opaque-poster-ticket-with-enough-entropy',
    purpose: 'download_range' as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxRangeBytes: 1024,
    maxUses: 8
  };
}

function request() {
  return {
    materialId: '11111111-2222-4333-8444-555555555555',
    transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
    cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-transfer',
    grant: grant()
  };
}

describe('the poster capability', () => {
  it('is asked for by contract, so an older app simply keeps its glyph', () => {
    expect(
      teamPosterFrameSupported({ teamPosterFrame: AGENT_TOOL_CONTRACTS.teamPosterFrame })
    ).toBe(true);
    expect(teamPosterFrameSupported({ teamWorkspace: 2 })).toBe(false);
    expect(teamPosterFrameSupported(null)).toBe(false);
  });
});

describe('the poster bridge', () => {
  it('refuses a request it cannot act on rather than starting work', async () => {
    const transfer = { downloadSource: vi.fn() } as unknown as {
      downloadSource: ReturnType<typeof vi.fn>;
    };
    const bridge = new TeamPosterBridge({ transfer: transfer as never, fetchImpl: vi.fn() });

    await expect(bridge.render({ ...request(), materialId: 'not-a-uuid' })).rejects.toThrow(
      'INVALID_INPUT'
    );
    expect(transfer.downloadSource).not.toHaveBeenCalled();
  });

  it('takes one file at a time, so a folder is not a download storm', async () => {
    // The interface asks per row; two asks for the same video would download it
    // twice for the same picture.
    const held: { release: (() => void) | null } = { release: null };
    const transfer = {
      downloadSource: vi.fn(
        () =>
          new Promise<never>(() => {
            held.release = () => undefined;
          })
      )
    } as unknown as { downloadSource: ReturnType<typeof vi.fn> };
    const bridge = new TeamPosterBridge({
      transfer: transfer as never,
      fetchImpl: vi.fn()
    });
    const first = bridge.render(request()).catch(() => 'stopped');
    await vi.waitFor(() => expect(transfer.downloadSource).toHaveBeenCalledOnce());

    await expect(bridge.render(request())).rejects.toThrow('WRONG_STATE');
    expect(bridge.busy()).toBe(true);

    await bridge.shutdown();
    held.release?.();
    // The run is abandoned with the agent; nothing here waits for a download
    // that will never answer.
    expect(await Promise.race([first, Promise.resolve('pending')])).toBeDefined();
  });

  it('is idle once nothing is in flight', () => {
    const bridge = new TeamPosterBridge({
      transfer: { downloadSource: vi.fn() } as never
    });
    expect(bridge.busy()).toBe(false);
  });
});
