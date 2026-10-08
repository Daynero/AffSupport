import { describe, expect, it, vi } from 'vitest';
import type { TeamRestitchDefaults } from '@video-compressor/shared';

/**
 * Feature 030, the browser's half of a delivery: ask the server to draw, ask for a grant on
 * each picture, hand the agent the lot. No bytes pass through here. One refused grant earns
 * one more draw without that picture; a second refusal is named for what it is.
 */

vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc: vi.fn() }),
  getSupabaseClient: () => ({ rpc: vi.fn() })
}));
vi.mock('../apps/web/src/api/client', () => ({ agentCanRestitchFromSpace: vi.fn() }));

const { prepareRestitchScreens } = await import('../apps/web/src/team/restitch/screens');
const { TeamApiError } = await import('../apps/web/src/api/team');

const TEAM = '30000000-0000-4000-8000-0000000000aa';
const defaults = (sourceMode: 'legacy' | 'drive'): TeamRestitchDefaults => ({
  operation: 'restitch',
  startImageIds: [],
  endImageIds: [],
  fitMode: 'cover',
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 2700,
  sourceMode,
  configured: true,
  updatedAt: '',
  updatedBy: null
});
const drawn = (materialId: string, slot: 'start' | 'end' = 'start') => ({
  slot,
  materialId,
  checksum: 'a'.repeat(32),
  mimeType: 'image/png' as const,
  fileName: `${materialId}.png`,
  sizeBytes: 10,
  driveVersion: '1'
});
const agentGrant = (materialId: string) => ({
  kind: 'agent' as const,
  transferUrl: `https://edge.test/range/${materialId}`,
  grant: {
    ticket: materialId,
    purpose: 'download_range' as const,
    expiresAt: '',
    maxRangeBytes: 1,
    maxUses: 2
  }
});

function deps(overrides: Partial<Parameters<typeof prepareRestitchScreens>[2]> = {}) {
  return {
    draw: vi
      .fn()
      .mockResolvedValue({
        sourceMode: 'drive',
        pool: { start: 'ready', end: 'ready' },
        screens: [drawn('m1'), drawn('m2', 'end')]
      }),
    grant: vi.fn(async (_team: string, materialId: string) => agentGrant(materialId)),
    capable: vi.fn().mockResolvedValue('yes'),
    ...overrides
  } as unknown as NonNullable<Parameters<typeof prepareRestitchScreens>[2]>;
}

describe('preparing the screens', () => {
  it('goes the old way for a legacy space without asking anybody', async () => {
    const d = deps();
    expect(await prepareRestitchScreens(TEAM, defaults('legacy'), d)).toEqual({ kind: 'legacy' });
    expect(d.draw).not.toHaveBeenCalled();
    expect(d.capable).not.toHaveBeenCalled();
  });

  it('says the app is too old before drawing anything', async () => {
    const d = deps({ capable: vi.fn().mockResolvedValue('too-old') });
    expect(await prepareRestitchScreens(TEAM, defaults('drive'), d)).toEqual({ kind: 'too-old' });
    expect(d.draw).not.toHaveBeenCalled();
  });

  it('draws, grants each picture to the app, and carries the grants', async () => {
    const d = deps();
    const result = await prepareRestitchScreens(TEAM, defaults('drive'), d);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(d.grant).toHaveBeenCalledWith(TEAM, 'm1', 'agent');
    expect(d.grant).toHaveBeenCalledWith(TEAM, 'm2', 'agent');
    expect(
      result.screens.map(screen => [screen.slot, screen.materialId, screen.transfer?.grant.ticket])
    ).toEqual([
      ['start', 'm1', 'm1'],
      ['end', 'm2', 'm2']
    ]);
    expect(result.screens[0]).not.toHaveProperty('driveVersion');
  });

  it('draws once more without a picture whose grant was refused, then names the refusal', async () => {
    const draw = vi
      .fn()
      .mockResolvedValueOnce({
        sourceMode: 'drive',
        pool: { start: 'ready', end: 'empty' },
        screens: [drawn('m1')]
      })
      .mockResolvedValueOnce({
        sourceMode: 'drive',
        pool: { start: 'ready', end: 'empty' },
        screens: [drawn('m3')]
      });
    const grant = vi.fn(async (_team: string, materialId: string) => {
      if (materialId === 'm1') throw new TeamApiError('TOO_LARGE', false);
      return agentGrant(materialId);
    });
    const result = await prepareRestitchScreens(TEAM, defaults('drive'), deps({ draw, grant }));
    expect(draw).toHaveBeenNthCalledWith(2, TEAM, { exclude: ['m1'] });
    expect(result.kind === 'ready' && result.screens.map(screen => screen.materialId)).toEqual([
      'm3'
    ]);

    const forbidden = vi.fn(async () => {
      throw new TeamApiError('PERMISSION_DENIED', false);
    });
    await expect(
      prepareRestitchScreens(
        TEAM,
        defaults('drive'),
        deps({
          draw: vi
            .fn()
            .mockResolvedValue({ sourceMode: 'drive', pool: {}, screens: [drawn('m1')] }),
          grant: forbidden
        })
      )
    ).rejects.toMatchObject({ code: 'RESTITCH_SOURCE_FORBIDDEN' });
  });

  it('lets the pool-empty refusal through untouched', async () => {
    const d = deps({
      draw: vi.fn().mockRejectedValue(new TeamApiError('RESTITCH_POOL_EMPTY', false))
    });
    await expect(prepareRestitchScreens(TEAM, defaults('drive'), d)).rejects.toMatchObject({
      code: 'RESTITCH_POOL_EMPTY'
    });
  });
});
