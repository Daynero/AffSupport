import { expect, it, vi } from 'vitest';
import { generateLaunch } from '../supabase/functions/drive-ops/launches';
import { parseTeamRestitchDefaults } from '../packages/shared/src/team/restitch';
import { launchConfig, launchSources } from './fixtures/launches';
const id = (n: number) => 'c1711000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture(options: { reuse?: boolean; sourceOnly?: boolean; contextError?: boolean } = {}) {
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 3,
      restitchEnabled: !options.sourceOnly,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 60,
      catalogVideoProtocolVersion: 1,
      videoVariationCount: 1,
      videoPublication: { mode: 'immediate' }
    }
  });
  const source = {
    ...launchSources,
    schemaVersion: 1,
    agentRowId: config.agentRowId,
    offerId: config.offerId,
    buyerId: config.buyerId,
    materialId: config.materialId,
    catalogSettingsVersion: '1'
  };
  const defaults = parseTeamRestitchDefaults({
    configured: true,
    operation: 'restitch',
    sourceMode: 'drive',
    startEnabled: false,
    endEnabled: true,
    finalDurationMode: 'custom',
    customFinalDurationSeconds: 60
  });
  if (!defaults.ok) throw Error('Invalid fixture defaults');
  const frozen = {
    setId: id(10),
    assignmentSeed: 'a'.repeat(64),
    recipeRowIds: [id(11), id(12), id(13)],
    childRequestIds: [id(14)]
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'service_initial_catalog_video_context' && options.contextError)
      return { data: null, error: { message: 'unavailable' } };
    let data: unknown;
    switch (name) {
      case 'find_launch_generation':
        data = null;
        break;
      case 'get_launch':
        data = { version: 'v1', draft: config };
        break;
      case 'service_launch_sources':
        data = source;
        break;
      case 'service_initial_catalog_video_context':
        data = { executorId: null, defaults: defaults.value };
        break;
      case 'service_catalog_publication_clock':
        data = Date.now();
        break;
      case 'service_find_launch_catalog_video_reuse':
        data = options.reuse
          ? {
              plan: frozen,
              executorId: id(20),
              settings: defaults.value,
              settingsDigest: args.p_digest
            }
          : null;
        break;
      case 'service_accept_launch_catalog_video_generation':
        data = { id: id(30), fence: '1', state: 'accepted' };
        break;
      default:
        throw Error('Unexpected fixture RPC ' + name);
    }
    return { data, error: null };
  });
  const proveSource = vi.fn(async () => undefined);
  const run = () =>
    generateLaunch(
      { caller: { rpc }, service: { rpc }, catalogReady: async () => undefined, proveSource },
      { teamId: id(1), launchId: id(2), expectedVersion: 'v1', requestKey: id(3) },
      id(4)
    );
  return { rpc, run, frozen, proveSource };
}
it('reports missing native executor as nonretryable setup guidance before admitting a generation', async () => {
  const f = fixture();
  await expect(f.run()).rejects.toMatchObject({ code: 'AGENT_REQUIRED', retryable: false });
  expect(f.proveSource).toHaveBeenCalledOnce();
  expect(f.rpc.mock.calls.map(([name]) => name)).toContain(
    'service_find_launch_catalog_video_reuse'
  );
  expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain(
    'service_accept_launch_catalog_video_generation'
  );
});
it('retains a verified READY reuse when there is no currently delegated executor', async () => {
  const f = fixture({ reuse: true });
  await expect(f.run()).resolves.toMatchObject({ id: id(30), state: 'accepted' });
  const admission = f.rpc.mock.calls.find(
    ([name]) => name === 'service_accept_launch_catalog_video_generation'
  )![1];
  expect(admission.p_video).toMatchObject({ executorId: id(20), plan: f.frozen });
});
it('allows source-only catalog generation without a native executor', async () => {
  const f = fixture({ sourceOnly: true });
  await expect(f.run()).resolves.toMatchObject({ id: id(30), state: 'accepted' });
  const admission = f.rpc.mock.calls.find(
    ([name]) => name === 'service_accept_launch_catalog_video_generation'
  )![1];
  expect(admission.p_video).toMatchObject({ executorId: null, settings: null, assignments: [] });
});
it('retains actual context transport failures as transport errors instead of claiming setup is missing', async () => {
  const f = fixture({ contextError: true });
  await expect(f.run()).rejects.toMatchObject({
    code: 'TEAM_TRANSPORT_UNAVAILABLE',
    retryable: true
  });
  expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain(
    'service_accept_launch_catalog_video_generation'
  );
});
