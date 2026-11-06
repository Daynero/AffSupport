import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const rpc = vi.fn();
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));
const { teamApi } = await import('../apps/web/src/api/team');
const { setPrivateCacheScope } = await import('../apps/web/src/team/private-cache-scope');
beforeEach(() => setPrivateCacheScope('47000000-0000-4000-8000-000000000001', 'owner'));
afterEach(() => rpc.mockReset());
const profile = {
  catalog_material_id: 'catalog',
  refresh_images: true,
  refresh_texts: true,
  grow_products: false,
  random_link_variation: true,
  restitch: false,
  version: 1,
  updated_at: '2026-10-18T10:00:00Z'
};
it('retains partial outcome independently of the last verified full success', async () => {
  rpc.mockResolvedValue({
    error: null,
    data: [
      {
        ...profile,
        last_result: 'partial',
        latest_attempt_at: '2026-10-18T10:00:00Z',
        last_successful_at: '2026-10-17T10:00:00Z'
      }
    ]
  });
  expect(await teamApi.listCatalogUpdateProfiles('team')).toEqual([
    expect.objectContaining({
      lastResult: 'partial',
      latestAttemptAt: '2026-10-18T10:00:00Z',
      lastSuccessfulAt: '2026-10-17T10:00:00Z'
    })
  ]);
});
it('distinguishes legacy missing evidence from known absence of attempts and success', async () => {
  rpc.mockResolvedValue({
    error: null,
    data: [
      profile,
      { ...profile, last_result: null, latest_attempt_at: null, last_successful_at: null }
    ]
  });
  const [legacy, known] = await teamApi.listCatalogUpdateProfiles('team');
  expect(legacy.lastResult).toBeUndefined();
  expect(legacy.lastSuccessfulAt).toBeUndefined();
  expect(known.lastResult).toBeNull();
  expect(known.latestAttemptAt).toBeNull();
  expect(known.lastSuccessfulAt).toBeNull();
});
it('never turns invalid outcome evidence into success or a usable timestamp', async () => {
  rpc.mockResolvedValue({
    error: null,
    data: [
      {
        ...profile,
        last_result: 'made-up-success',
        latest_attempt_at: 'invalid',
        last_successful_at: 123
      }
    ]
  });
  expect(await teamApi.listCatalogUpdateProfiles('team')).toEqual([
    expect.objectContaining({
      lastResult: 'unknown',
      latestAttemptAt: undefined,
      lastSuccessfulAt: undefined
    })
  ]);
});

it('retains the precise calendar schedule from the profile list and patch response', async () => {
  const schedule = { timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' };
  rpc.mockResolvedValue({ error: null, data: [{ ...profile, schedule }] });
  expect((await teamApi.listCatalogUpdateProfiles('team'))[0].schedule).toEqual(schedule);
  rpc.mockResolvedValue({
    error: null,
    data: {
      catalogId: 'catalog',
      refreshImages: true,
      refreshTexts: true,
      growProducts: false,
      randomLinkVariation: true,
      restitch: false,
      version: 2,
      updatedAt: profile.updated_at,
      schedule
    }
  });
  expect(
    (
      await teamApi.patchCatalogUpdateProfile('team', 'catalog', 1, {
        updateInterval: '1w',
        schedule
      })
    ).schedule
  ).toEqual(schedule);
});

it.each([null, '1', -1, 1.5, NaN, Infinity])(
  'rejects malformed run/retry counts instead of reporting a no-op: %s',
  async data => {
    rpc.mockResolvedValue({ error: null, data });
    await expect(teamApi.runCatalogUpdateNow('team', ['catalog'])).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
    await expect(teamApi.retryCatalogUpdate('team', 'catalog', 'attempt')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  }
);
it.each([null, 0, 'false', undefined])('rejects malformed cancellation: %s', async data => {
  rpc.mockResolvedValue({ error: null, data });
  await expect(
    teamApi.cancelCatalogUpdate('team', 'catalog', {
      roundAt: '2026-11-05T10:00:00Z',
      attemptId: null
    })
  ).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
});
it('retains genuine command no-ops', async () => {
  rpc.mockResolvedValue({ error: null, data: 0 });
  expect(await teamApi.runCatalogUpdateNow('team', ['catalog'])).toBe(0);
  expect(await teamApi.retryCatalogUpdate('team', 'catalog', 'attempt')).toBe(0);
  rpc.mockResolvedValue({ error: null, data: false });
  expect(
    await teamApi.cancelCatalogUpdate('team', 'catalog', {
      roundAt: '2026-11-05T10:00:00Z',
      attemptId: null
    })
  ).toBe(false);
});

it('does not present a malformed profile row as a successfully loaded empty list', async () => {
  rpc.mockResolvedValue({ error: null, data: [{ unexpected: true }] });
  await expect(teamApi.listCatalogUpdateProfiles('team')).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
});
it('does not silently drop malformed registry rows', async () => {
  rpc.mockResolvedValue({ error: null, data: [{ unexpected: true }] });
  await expect(teamApi.listTeamProductCatalogs('team')).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
});
it('accepts genuinely empty lists', async () => {
  rpc.mockResolvedValue({ error: null, data: [] });
  expect(await teamApi.listTeamProductCatalogs('team')).toEqual([]);
  expect(await teamApi.listCatalogUpdateProfiles('team')).toEqual([]);
});
it('preserves valid profiles while making malformed omissions explicit', async () => {
  rpc.mockResolvedValue({ error: null, data: [profile, { unexpected: true }] });
  const result = await teamApi.listCatalogUpdateProfileSnapshot('team');
  expect(result.invalidRowCount).toBe(1);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].catalogId).toBe('catalog');
});
it('distinguishes all-invalid registry data from a genuinely empty snapshot', async () => {
  rpc.mockResolvedValue({ error: null, data: [{ unexpected: true }] });
  expect(await teamApi.listTeamProductCatalogSnapshot('team')).toEqual({
    rows: [],
    invalidRowCount: 1
  });
  rpc.mockResolvedValue({ error: null, data: [] });
  expect(await teamApi.listTeamProductCatalogSnapshot('team')).toEqual({
    rows: [],
    invalidRowCount: 0
  });
});

it('joins only valid catalog/profile rows from a single manager snapshot RPC', async () => {
  const catalog = {
    catalog_id: 'catalog',
    name: 'Catalog',
    sheet_url: 'https://docs.google.com/spreadsheets/d/catalog',
    video_id: 'video',
    video_name: 'Video',
    product_count: 2,
    created_at: '2026-11-05T10:00:00Z',
    update_count: 0,
    in_updater: false
  };
  rpc.mockResolvedValue({
    error: null,
    data: {
      observed_at: '2026-11-05T12:00:00Z',
      catalogs: [catalog, { ...catalog, catalog_id: 'missing-profile' }],
      profiles: [profile]
    }
  });
  const data = await teamApi.listCatalogManagerSnapshot('team');
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith('list_team_catalog_manager_snapshot', { p_team: 'team' });
  expect(data.rows).toHaveLength(1);
  expect(data.rows[0].profile?.version).toBe(1);
  expect(data.invalidRowCount).toBe(1);
  expect(data.rows[0].runtimeObservedAt).toBe('2026-11-05T12:00:00Z');
});

it.each([
  { created_at: 'not-a-date' },
  { product_count: -1 },
  { product_count: 1.5 },
  { update_count: -1 },
  { update_interval: 'not-an-interval' },
  { next_run_at: 'bad' },
  { update_pending: 'false' },
  { update_pending: 0 },
  { update_pending: null }
])(
  'keeps malformed catalog fields partial instead of crashing the manager or showing a false disabled schedule: %j',
  async bad => {
    const row = {
      catalog_id: 'good',
      name: 'Catalog',
      sheet_url: 'https://docs.google.com/spreadsheets/d/good',
      video_id: 'video',
      video_name: 'Video',
      product_count: 1,
      update_count: 0,
      created_at: '2026-11-05T12:00:00Z',
      in_updater: false
    };
    rpc.mockResolvedValue({ error: null, data: [row, { ...row, catalog_id: 'bad', ...bad }] });
    expect(await teamApi.listTeamProductCatalogSnapshot('team')).toMatchObject({
      rows: [{ catalogId: 'good' }],
      invalidRowCount: 1
    });
  }
);

it.each([
  { started_at: 'invalid' },
  { ended_at: 'invalid' },
  { delivery_verified_at: 'invalid' },
  { catalog_material_id: 'another-catalog' },
  { profile_version: -1 }
])(
  'refuses malformed or cross-catalog history rather than showing empty success: %j',
  async bad => {
    rpc.mockResolvedValue({
      error: null,
      data: [
        {
          attempt_id: 'attempt',
          catalog_material_id: 'catalog',
          trigger_kind: 'manual',
          started_at: '2026-11-05T12:00:00Z',
          ended_at: null,
          delivery_verified_at: null,
          result: 'failed',
          ...bad
        }
      ]
    });
    await expect(teamApi.listCatalogUpdateAttempts('team', 'catalog')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  }
);
it('retains a genuine empty history and excludes invalid optional stage timestamps', async () => {
  rpc.mockResolvedValueOnce({ error: null, data: [] });
  expect(await teamApi.listCatalogUpdateAttempts('team', 'catalog')).toEqual([]);
  rpc.mockResolvedValueOnce({
    error: null,
    data: [
      {
        attempt_id: 'attempt',
        catalog_material_id: 'catalog',
        trigger_kind: 'manual',
        started_at: '2026-11-05T12:00:00Z',
        result: 'running',
        stage_history: [{ stage: 'uploading', at: 'invalid' }]
      }
    ]
  });
  expect((await teamApi.listCatalogUpdateAttempts('team', 'catalog'))[0]?.stages).toEqual([]);
});

it('refuses more accepted work than the command could have requested', async () => {
  rpc.mockResolvedValue({ error: null, data: 2 });
  await expect(teamApi.runCatalogUpdateNow('team', ['catalog'])).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
  await expect(teamApi.retryCatalogUpdate('team', 'catalog', 'attempt')).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
});

it('uses the observed-round stop RPC and never falls back to an unfenced stop on conflict', async () => {
  const observed = { roundAt: '2026-11-05T10:00:00Z', attemptId: null };
  rpc.mockResolvedValueOnce({ error: null, data: false });
  expect(await teamApi.cancelCatalogUpdate('team', 'catalog', observed)).toBe(false);
  expect(rpc).toHaveBeenLastCalledWith('cancel_team_catalog_update_attempt_as_actor', {
    p_team: 'team',
    p_catalog: 'catalog',
    p_expected_actor: '47000000-0000-4000-8000-000000000001',
    p_expected_round: observed.roundAt,
    p_expected_attempt: null
  });
  rpc.mockResolvedValueOnce({ error: { message: 'STALE_RESULT', code: '40001' }, data: null });
  await expect(teamApi.cancelCatalogUpdate('team', 'catalog', observed)).rejects.toMatchObject({
    code: 'STALE_RESULT'
  });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(
    rpc.mock.calls.every(([name]) => name === 'cancel_team_catalog_update_attempt_as_actor')
  ).toBe(true);
});
it('refuses an invalid observed stop identity before sending any RPC', async () => {
  await expect(
    teamApi.cancelCatalogUpdate('team', 'catalog', { roundAt: 'invalid', attemptId: null })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rpc).not.toHaveBeenCalled();
});

it('does not invent freshness when manager observation metadata is malformed', async () => {
  rpc.mockResolvedValue({
    error: null,
    data: { observed_at: 'invalid', catalogs: [], profiles: [] }
  });
  await expect(teamApi.listCatalogManagerSnapshot('team')).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
});

it('refuses Stop without an observed target before sending any RPC', async () => {
  await expect(teamApi.cancelCatalogUpdate('team', 'catalog')).rejects.toMatchObject({
    code: 'CATALOG_STOP_TARGET_UNKNOWN'
  });
  expect(rpc).not.toHaveBeenCalled();
});
