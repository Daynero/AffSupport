import { expect, it, vi } from 'vitest';
import {
  handleCatalogPublicationRead,
  handleCatalogPublicationSave,
  handleCatalogPublicationAction
} from '../supabase/functions/drive-ops/catalog-publication';
const team = '77000000-0000-4000-8000-000000000021',
  actor = '77000000-0000-4000-8000-000000000022',
  catalog = '77000000-0000-4000-8000-000000000023',
  request = '77000000-0000-4000-8000-000000000024',
  source = '77000000-0000-4000-8000-000000000025',
  job = '77000000-0000-4000-8000-000000000026';
const now = Date.parse('2030-01-01T00:00:00Z');
const snapshot = {
  catalogId: catalog,
  revision: 1,
  serverNow: now,
  mode: 'held',
  dueAt: null,
  timeZone: null,
  target: { kind: 'source', materialId: source, sourceVersion: 'v1' },
  job: { id: job, revision: 1, state: 'held', writerFence: null },
  active: null
};
it('reads exact request evidence without falling back to a newer catalog snapshot', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  expect(
    await handleCatalogPublicationRead({ rpc }, actor, {
      teamId: team,
      expectedActorId: actor,
      catalogId: catalog,
      requestId: request
    })
  ).toBeNull();
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith(
    'service_read_catalog_publication_command',
    expect.objectContaining({ p_actor: actor, p_request: request })
  );
});
it('uses the verified actor rather than a spoofed body actor and accepts real PromiseLike SDK queries', async () => {
  const rpc = vi.fn(() => Promise.resolve({ data: snapshot, error: null }));
  const result = await handleCatalogPublicationSave(
    { rpc },
    actor,
    {
      teamId: team,
      expectedActorId: actor,
      actorId: source,
      requestId: request,
      catalogId: catalog,
      expectedRevision: 0,
      publication: { mode: 'held' },
      target: snapshot.target
    },
    now
  );
  expect(result.active).toBeNull();
  expect(rpc).toHaveBeenCalledWith(
    'service_save_catalog_publication',
    expect.objectContaining({ p_actor: actor, p_mode: 'held', p_due: null })
  );
});
it('rejects malformed responses and invalid commands before reporting success', async () => {
  const rpc = vi.fn(async () => ({ data: { ...snapshot, revision: 9 }, error: null }));
  await expect(
    handleCatalogPublicationSave(
      { rpc },
      actor,
      {
        teamId: team,
        expectedActorId: actor,
        requestId: request,
        catalogId: catalog,
        expectedRevision: 0,
        publication: { mode: 'held' },
        target: snapshot.target
      },
      now
    )
  ).rejects.toThrow('INVALID_RESPONSE');
  rpc.mockClear();
  await expect(
    handleCatalogPublicationSave(
      { rpc },
      actor,
      {
        teamId: team,
        expectedActorId: actor,
        requestId: request,
        catalogId: catalog,
        expectedRevision: 0,
        target: snapshot.target
      },
      now
    )
  ).rejects.toThrow('INVALID_INPUT');
  expect(rpc).not.toHaveBeenCalled();
});

it('rejects a replacement authenticated actor before accepting an old UI save', async () => {
  const rpc = vi.fn(async () => ({ data: snapshot, error: null }));
  await expect(
    handleCatalogPublicationSave(
      { rpc },
      source,
      {
        teamId: team,
        expectedActorId: actor,
        requestId: request,
        catalogId: catalog,
        expectedRevision: 0,
        publication: { mode: 'held' },
        target: snapshot.target
      },
      now
    )
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(rpc).not.toHaveBeenCalled();
});

it('add-now preserves the server target and uses the same no-writer CAS', async () => {
  const after = {
    ...snapshot,
    revision: 2,
    mode: 'immediate',
    job: { ...snapshot.job, revision: 2, state: 'waiting' }
  };
  const rpc = vi.fn(async (name: string) => ({
    data:
      name === 'service_read_catalog_publication_command'
        ? null
        : name === 'service_read_catalog_publication'
          ? snapshot
          : after,
    error: null
  }));
  expect(
    await handleCatalogPublicationAction({ rpc }, actor, {
      teamId: team,
      catalogId: catalog,
      requestId: request,
      expectedActorId: actor,
      expectedRevision: 1,
      action: 'add_now'
    })
  ).toMatchObject({ mode: 'immediate', active: null });
  expect(rpc).toHaveBeenLastCalledWith(
    'service_save_catalog_publication',
    expect.objectContaining({
      p_mode: 'immediate',
      p_target: snapshot.target,
      p_expected_revision: 1
    })
  );
});
it('reconciles only the original cancel receipt and rejects a changed action', async () => {
  const rpc = vi.fn(async () => ({ data: snapshot, error: null }));
  const body = {
    teamId: team,
    catalogId: catalog,
    requestId: request,
    expectedActorId: actor,
    expectedRevision: 0,
    action: 'cancel'
  };
  expect(await handleCatalogPublicationAction({ rpc }, actor, body)).toMatchObject({
    mode: 'held'
  });
  await expect(
    handleCatalogPublicationAction({ rpc }, actor, { ...body, action: 'add_now' })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rpc).toHaveBeenCalledTimes(2);
});
