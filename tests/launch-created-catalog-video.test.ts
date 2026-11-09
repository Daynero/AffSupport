import { expect, it, vi } from 'vitest';
import {
  readLaunchCatalogVideo,
  cancelLaunchCatalogVideo
} from '../supabase/functions/drive-ops/launch-created-catalog-video';
const id = (n: number) => '77000000-0000-4000-8000-' + String(n).padStart(12, '0');
const body = { teamId: id(1), generationId: id(2), expectedActorId: id(3) };
const receipt = {
  outcome: 'created',
  videoShared: false,
  catalog: {
    materialId: id(4),
    name: 'Fixture',
    sheetUrl: 'https://example.invalid/sheet',
    sourceLink: 'https://example.invalid/offer',
    productCount: 3,
    createdAt: null
  },
  videoGenerationObservation: {
    videoSetId: id(5),
    requestedCount: 2,
    registeredCount: 0,
    state: 'preparing',
    catalogVideoCells: 'deferred_blank'
  }
};
it('keeps post-created Launch N controls scoped to exact actor/generation without exposing private canonical keys', async () => {
  const rpc = vi.fn(async () => ({
    data: { ...receipt, privateRequestKey: 'must-not-leak' },
    error: null
  }));
  expect(await readLaunchCatalogVideo({ rpc } as never, id(3), body)).toEqual(receipt);
  expect(rpc).toHaveBeenCalledWith('service_created_launch_catalog_video', {
    p_team: id(1),
    p_actor: id(3),
    p_generation: id(2),
    p_action: 'read',
    p_request: null
  });
  await cancelLaunchCatalogVideo({ rpc } as never, id(3), { ...body, requestId: id(6) });
  expect(rpc).toHaveBeenLastCalledWith('service_created_launch_catalog_video', {
    p_team: id(1),
    p_actor: id(3),
    p_generation: id(2),
    p_action: 'cancel',
    p_request: id(6)
  });
});
it('rejects actor replacement and malformed current N observation before returning success', async () => {
  const rpc = vi.fn(async () => ({
    data: {
      ...receipt,
      videoGenerationObservation: { ...receipt.videoGenerationObservation, registeredCount: 3 }
    },
    error: null
  }));
  await expect(readLaunchCatalogVideo({ rpc } as never, id(7), body)).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  expect(rpc).not.toHaveBeenCalled();
  await expect(readLaunchCatalogVideo({ rpc } as never, id(3), body)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
});
