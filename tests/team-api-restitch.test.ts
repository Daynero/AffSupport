import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Feature 030: the four pool calls the panel and the deliveries make, narrowed at the
 * boundary. What is worth proving is that a listing the server could not shape is refused
 * rather than rendered, and that a SQL refusal arrives as its own code.
 */

const rpc = vi.fn();

vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));

const { teamApi, TeamApiError } = await import('../apps/web/src/api/team');

const TEAM = '30000000-0000-4000-8000-0000000000aa';
const listing = {
  sourceMode: 'drive',
  legacyImageCount: 0,
  pools: {
    start: { state: 'ready', overLimit: false, eligibleCount: 2, sources: [] },
    end: { state: 'empty', overLimit: false, eligibleCount: 0, sources: [] }
  }
};

afterEach(() => {
  rpc.mockReset();
});

describe('the pools over the wire', () => {
  it('lists the space pool or the caller’s own, as asked', async () => {
    rpc.mockResolvedValue({ data: listing, error: null });
    const result = await teamApi.listRestitchSources(TEAM, 'self');
    expect(rpc).toHaveBeenCalledWith('list_restitch_sources', { p_team: TEAM, p_scope: 'self' });
    expect(result.pools.start.eligibleCount).toBe(2);
  });

  it('refuses a listing it cannot read instead of rendering half of it', async () => {
    rpc.mockResolvedValue({ data: { pools: { start: listing.pools.start } }, error: null });
    await expect(teamApi.listRestitchSources(TEAM, 'owner')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  });

  it('writes a slot of either pool with references only', async () => {
    rpc.mockResolvedValue({ data: listing, error: null });
    await teamApi.setRestitchSources(TEAM, 'start', [{ materialId: 'm1' }]);
    expect(rpc).toHaveBeenLastCalledWith('set_restitch_sources', {
      p_team: TEAM,
      p_slot: 'start',
      p_items: [{ materialId: 'm1' }]
    });
    await teamApi.setMemberRestitchSources(TEAM, 'end', [{ driveFileId: 'd1', kind: 'folder' }]);
    expect(rpc).toHaveBeenLastCalledWith('set_member_restitch_sources', {
      p_team: TEAM,
      p_slot: 'end',
      p_items: [{ driveFileId: 'd1', kind: 'folder' }]
    });
  });

  it('carries a SQL refusal as its code', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'RESTITCH_SOURCES_TOO_MANY', code: '22023' }
    });
    await expect(teamApi.setRestitchSources(TEAM, 'start', [])).rejects.toBeInstanceOf(
      TeamApiError
    );
    await expect(teamApi.setRestitchSources(TEAM, 'start', [])).rejects.toMatchObject({
      code: 'RESTITCH_SOURCES_TOO_MANY'
    });
  });

  it('draws with an exclusion and refuses a draw with a bad screen', async () => {
    rpc.mockResolvedValue({
      data: {
        sourceMode: 'drive',
        pool: { start: 'ready', end: 'ready' },
        screens: [
          {
            slot: 'start',
            materialId: 'm1',
            checksum: 'abc',
            mimeType: 'image/png',
            fileName: 'a.png',
            sizeBytes: 10
          }
        ]
      },
      error: null
    });
    const drawn = await teamApi.drawRestitchScreens(TEAM, { exclude: ['m9'] });
    expect(rpc).toHaveBeenCalledWith('draw_restitch_screens', { p_team: TEAM, p_exclude: ['m9'] });
    expect(drawn.screens[0]?.materialId).toBe('m1');
    rpc.mockResolvedValue({ data: { screens: [{ slot: 'start' }] }, error: null });
    await expect(teamApi.drawRestitchScreens(TEAM)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  });
});
