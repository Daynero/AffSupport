import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import type { SpaceStorageJournalEntry } from '../supabase/functions/_shared/space-storage-journal';
import { createSpace } from '../supabase/functions/space-storage/create';
import {
  checkSpaceRequest,
  parseCreateSpaceCommand,
  parseSpaceStorageContext,
  requireSpaceRequest,
  requireSpaceStorageClient,
  spaceRpcError,
  spaceStorageClient,
  spaceStorageRoute,
  spaceStorageRoutePath,
  type SpaceStorageContext
} from '../supabase/functions/space-storage/handler';

/**
 * 057 T013 — `/spaces/create` and the request checks every space-storage route shares (T015),
 * against a fake database. The real idempotency, permit and root folder are proven in SQL
 * (supabase/tests/database/space-storage-pilot.test.sql); here: what the function asks the
 * database, what it answers, and in which order it refuses.
 */

const ACTOR = '05713000-0000-4000-8000-000000000001';
const TEAM = '05713000-0000-4000-8000-000000000011';
const ROOT = '05713000-0000-4000-8000-000000000101';
const KEY = 'f0b3c6a2-2b9e-4a52-9d55-6d0e8f1c2a77';
const OPERATION = '05713000-0000-4000-8000-0000000000aa';

const snapshot = {
  teamId: TEAM,
  rootMaterialId: ROOT,
  storageBackend: 'r2',
  storagePilot: true,
  name: 'Pilot space',
  role: 'owner',
  permissions: {
    view: true,
    download: true,
    upload: true,
    edit: true,
    delete: true,
    process: true,
    manage_members: true,
    manage_metadata: true
  },
  connectionState: 'none',
  contentRevision: '0'
};

/** A fake of `service_create_r2_space` with the database's rule: one space per key and person. */
function fakeDatabase(options: { pilot: boolean }) {
  const spaces = new Map<string, typeof snapshot>();
  const roots = new Map<string, string>();
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    expect(name).toBe('service_create_r2_space');
    if (!options.pilot) throw new TeamFunctionError('R2_PILOT_REQUIRED');
    const key = `${String(args.p_actor)}:${String(args.p_idempotency_key)}`;
    const existing = spaces.get(key);
    if (existing) return existing;
    const created = { ...snapshot, name: String(args.p_name) };
    spaces.set(key, created);
    roots.set(created.teamId, created.rootMaterialId);
    return created;
  });
  return { rpc, spaces, roots };
}

const journalEntries: SpaceStorageJournalEntry[] = [];
const deps = (rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>) => ({
  actorId: ACTOR,
  rpc,
  journal: async (entry: SpaceStorageJournalEntry) => {
    journalEntries.push(entry);
    return true;
  },
  operationId: OPERATION,
  client: { kind: 'web' as const, version: '1.8.0+110' }
});

describe('/spaces/create', () => {
  it('creates the space with its root folder and answers its snapshot', async () => {
    const database = fakeDatabase({ pilot: true });
    const created = await createSpace(
      parseCreateSpaceCommand({ name: '  Pilot   space ', idempotencyKey: KEY }),
      deps(database.rpc)
    );
    expect(database.rpc).toHaveBeenCalledWith('service_create_r2_space', {
      p_actor: ACTOR,
      p_name: 'Pilot space',
      p_idempotency_key: KEY
    });
    expect(created).toMatchObject({
      teamId: TEAM,
      rootMaterialId: ROOT,
      storageBackend: 'r2',
      role: 'owner',
      connectionState: 'none'
    });
    expect(database.roots.get(TEAM)).toBe(ROOT);
  });

  it('is idempotent by key: a retry after a lost reply returns the same space', async () => {
    const database = fakeDatabase({ pilot: true });
    const command = parseCreateSpaceCommand({ name: 'Pilot space', idempotencyKey: KEY });
    const first = await createSpace(command, deps(database.rpc));
    const second = await createSpace(command, deps(database.rpc));
    expect(second).toEqual(first);
    expect(database.spaces.size).toBe(1);
  });

  it('refuses a person without the permit with R2_PILOT_REQUIRED and journals it', async () => {
    journalEntries.length = 0;
    const database = fakeDatabase({ pilot: false });
    await expect(
      createSpace(
        parseCreateSpaceCommand({ name: 'Pilot space', idempotencyKey: KEY }),
        deps(database.rpc)
      )
    ).rejects.toMatchObject({ code: 'R2_PILOT_REQUIRED', status: 403, retryable: false });
    expect(journalEntries).toEqual([
      expect.objectContaining({ stage: 'create', outcome: 'rejected', code: 'R2_PILOT_REQUIRED' })
    ]);
    expect(JSON.stringify(journalEntries)).not.toContain('Pilot space');
  });

  it('never accepts a snapshot that is not an R2 space', async () => {
    const rpc = vi.fn(async () => ({ ...snapshot, storageBackend: 'drive' }));
    await expect(
      createSpace(parseCreateSpaceCommand({ name: 'x', idempotencyKey: KEY }), deps(rpc))
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('validates the command before anything reaches the database', () => {
    for (const body of [
      null,
      { name: 'x' },
      { name: '', idempotencyKey: KEY },
      { name: 'x'.repeat(121), idempotencyKey: KEY },
      { name: 'x', idempotencyKey: 'short' },
      { name: 'x', idempotencyKey: 'has spaces in it, sixteen+' }
    ]) {
      expect(() => parseCreateSpaceCommand(body)).toThrow('INVALID_INPUT');
    }
  });

  it('maps a database refusal to its code, anything else to a retryable 503', () => {
    expect(spaceRpcError({ message: 'R2_PILOT_REQUIRED', code: '42501' }).code).toBe(
      'R2_PILOT_REQUIRED'
    );
    expect(spaceRpcError({ message: 'duplicate key', code: '23505' }).code).toBe('NAME_CONFLICT');
    const unknown = spaceRpcError({ message: 'canceling statement due to timeout' });
    expect(unknown.code).toBe('STORAGE_UNAVAILABLE');
    expect(unknown.retryable).toBe(true);
  });
});

describe('the shared request checks', () => {
  it('asks a client without storage-r2/1 to update, before anything else', () => {
    expect(() => requireSpaceStorageClient(new Headers())).toThrow('CLIENT_UPDATE_REQUIRED');
    expect(() =>
      requireSpaceStorageClient(new Headers({ 'x-soty-capabilities': 'storage-r2/2' }))
    ).toThrow('CLIENT_UPDATE_REQUIRED');
    const refusal = (() => {
      try {
        requireSpaceStorageClient(new Headers());
      } catch (error) {
        return error as TeamFunctionError;
      }
    })();
    expect(refusal?.status).toBe(409);
    expect(() =>
      requireSpaceStorageClient(new Headers({ 'x-soty-capabilities': 'other/1, storage-r2/1' }))
    ).not.toThrow();
  });

  it('the entry checks the capability header before it reads the body or the caller', () => {
    const source = readFileSync('supabase/functions/space-storage/index.ts', 'utf8');
    const capability = source.indexOf('requireSpaceStorageClient(request.headers)');
    expect(capability).toBeGreaterThan(0);
    expect(capability).toBeLessThan(source.indexOf('parseJsonBody(request)'));
    expect(capability).toBeLessThan(source.indexOf('authorizeCaller(request'));
    expect(source).toContain("request.method !== 'POST'");
  });

  it('routes by path, as drive-ops does', () => {
    const path = spaceStorageRoutePath(
      new URL('https://x.supabase.co/functions/v1/space-storage/spaces/create')
    );
    expect(path).toBe('/spaces/create');
    expect(spaceStorageRoute(path)).toBe('/spaces/create');
    expect(() => spaceStorageRoute('/share-links')).toThrow('NOT_FOUND');
    expect(() => spaceStorageRoute('/uploads/{id}/parts')).toThrow('NOT_FOUND');
    expect(spaceStorageRoutePath(new URL('https://x/functions/v1/other'))).toBe('/');
  });

  it('journals the calling client only in its closed shape', () => {
    expect(
      spaceStorageClient(new Headers({ 'x-soty-client': 'web/1.8.0+110' }), '1.7.2+108')
    ).toEqual({ kind: 'web', version: '1.8.0+110' });
    expect(
      spaceStorageClient(new Headers({ 'x-soty-client': 'web/../../x' }), '1.7.2+108')
    ).toEqual({ kind: 'server', version: '1.7.2+108' });
  });

  const context = (fields: Partial<Record<keyof SpaceStorageContext, unknown>> = {}) =>
    parseSpaceStorageContext({
      member: true,
      storageBackend: 'r2',
      storagePilot: true,
      actorPilot: true,
      workspaceAllowed: true,
      archived: false,
      allowed: true,
      accessEpoch: '3',
      contentRevision: '9007199254740993',
      rootMaterialId: ROOT,
      ...fields
    });

  it('parses the context exactly and refuses anything else', () => {
    expect(context()?.contentRevision).toBe(9007199254740993n);
    expect(context({ member: 'yes' })).toBeNull();
    expect(context({ storageBackend: 's3' })).toBeNull();
    expect(context({ accessEpoch: 3 })).toBeNull();
  });

  it('refuses in the contract order: member, backend, pilot, archive, tariff, role', () => {
    const refusal = (fields: Partial<Record<keyof SpaceStorageContext, unknown>>) => {
      try {
        checkSpaceRequest(context(fields));
        return null;
      } catch (error) {
        return (error as TeamFunctionError).code;
      }
    };
    expect(() => checkSpaceRequest(null)).toThrow('PERMISSION_DENIED');
    expect(refusal({ member: false, storageBackend: 'drive' })).toBe('PERMISSION_DENIED');
    expect(refusal({ storageBackend: 'drive', actorPilot: false })).toBe(
      'STORAGE_BACKEND_MISMATCH'
    );
    // The owner may be a pilot (the database gate passes for a service call), the acting person not.
    expect(refusal({ actorPilot: false, workspaceAllowed: true })).toBe('R2_PILOT_REQUIRED');
    expect(refusal({ archived: true, workspaceAllowed: false })).toBe('SPACE_ARCHIVED');
    expect(refusal({ workspaceAllowed: false, allowed: false })).toBe('SPACE_BLOCKED');
    expect(refusal({ allowed: false })).toBe('PERMISSION_DENIED');
    expect(refusal({ storagePilot: false, actorPilot: false })).toBeNull();
    expect(refusal({})).toBeNull();
  });

  it('reads the context for the acting person and the action', async () => {
    const rpc = vi.fn(async () => ({
      member: true,
      storageBackend: 'r2',
      storagePilot: true,
      actorPilot: false,
      workspaceAllowed: true,
      archived: false,
      allowed: true,
      accessEpoch: '0',
      contentRevision: '0',
      rootMaterialId: ROOT
    }));
    await expect(
      requireSpaceRequest(rpc, { teamId: TEAM, actorId: ACTOR, permission: 'upload' })
    ).rejects.toMatchObject({ code: 'R2_PILOT_REQUIRED' });
    expect(rpc).toHaveBeenCalledWith('service_space_storage_context', {
      p_team: TEAM,
      p_actor: ACTOR,
      p_permission: 'upload'
    });
    await expect(
      requireSpaceRequest(async () => null, { teamId: TEAM, actorId: ACTOR, permission: 'view' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
