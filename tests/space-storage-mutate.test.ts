import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  emptyTrash,
  mutateMaterials,
  parseMutateCommand,
  parseReadMaterialsCommand,
  parseTrashEmptyCommand,
  readMaterials,
  SPACE_MUTATION_PERMISSION,
  type MutateDeps
} from '../supabase/functions/space-storage/mutate';

/**
 * 057 T024 — `/materials/mutate` and `/trash/empty` (T025) against a fake database. The
 * database rules (revisions, cycles, subtree trash, purge queue) are proven in
 * supabase/tests/database/space-storage-mutate.test.sql; here: the command shapes, the role
 * each action asks for, and how a stale revision reaches the client.
 */

const ACTOR = '05724000-0000-4000-8000-000000000001';
const TEAM = '05724000-0000-4000-8000-000000000011';
const ROOT = '05724000-0000-4000-8000-000000000101';
const FILE = '05724000-0000-4000-8000-000000000111';
const FOLDER = '05724000-0000-4000-8000-000000000121';

const material = {
  id: FILE,
  teamId: TEAM,
  parentMaterialId: ROOT,
  name: 'Renamed.png',
  kind: 'file',
  lifecycle: 'active',
  materialRevision: '2',
  contentId: '1'.repeat(64),
  sizeBytes: '100',
  mimeType: 'image/png'
};

function fakeDatabase(answer: (name: string, args: Record<string, unknown>) => unknown) {
  const permissions: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'service_space_storage_context') {
      permissions.push(String(args.p_permission));
      return {
        member: true,
        storageBackend: 'r2',
        storagePilot: true,
        actorPilot: true,
        workspaceAllowed: true,
        archived: false,
        allowed: args.p_permission !== 'delete',
        accessEpoch: '0',
        contentRevision: '4',
        rootMaterialId: ROOT
      };
    }
    return answer(name, args);
  });
  return { rpc, permissions };
}

const deps = (rpc: MutateDeps['rpc']): MutateDeps => ({
  actorId: ACTOR,
  rpc,
  journal: async () => true,
  operationId: '05724000-0000-4000-8000-0000000000ff',
  client: { kind: 'web', version: '1.8.0+110' }
});

describe('commands', () => {
  it('reads every action and refuses what does not fit it', () => {
    expect(
      parseMutateCommand({
        teamId: TEAM,
        action: 'rename',
        materialIds: [FILE],
        name: ' Renamed.png ',
        expectedRevision: '1'
      })
    ).toEqual({
      teamId: TEAM,
      action: 'rename',
      materialIds: [FILE],
      expectedRevisions: { [FILE]: '1' },
      name: 'Renamed.png'
    });
    expect(
      parseMutateCommand({ teamId: TEAM, action: 'create_folder', name: 'A', ensure: true })
    ).toMatchObject({ parentMaterialId: null, ensure: true, materialIds: [] });
    const bad = [
      { teamId: TEAM, action: 'delete', materialIds: [FILE] },
      { teamId: TEAM, action: 'rename', materialIds: [FILE, FOLDER], name: 'x' },
      { teamId: TEAM, action: 'rename', materialIds: [FILE], name: 'a/b' },
      { teamId: TEAM, action: 'move', materialIds: [FILE] },
      { teamId: TEAM, action: 'move', materialIds: [FILE], targetFolderId: 'drive-id' },
      { teamId: TEAM, action: 'trash', materialIds: [] },
      { teamId: TEAM, action: 'trash', materialIds: [FILE, FILE] },
      { teamId: TEAM, action: 'trash', materialIds: Array.from({ length: 101 }, () => FILE) },
      { teamId: TEAM, action: 'rename', materialIds: [FILE], name: 'x', expectedRevision: 1 },
      { teamId: TEAM, action: 'create_folder', name: 'x', materialIds: [FILE] }
    ];
    for (const body of bad) expect(() => parseMutateCommand(body)).toThrow('INVALID_INPUT');
    expect(parseTrashEmptyCommand({ teamId: TEAM })).toEqual({ teamId: TEAM, materialIds: null });
    expect(() => parseTrashEmptyCommand({ teamId: TEAM, materialIds: [] })).toThrow(
      'INVALID_INPUT'
    );
  });

  it('asks for the role each action needs, as the Drive routes do', () => {
    expect(SPACE_MUTATION_PERMISSION).toEqual({
      rename: 'edit',
      move: 'edit',
      copy: 'upload',
      create_folder: 'upload',
      trash: 'delete',
      restore: 'delete'
    });
  });
});

describe('mutations', () => {
  it('returns the materials and the new content revision', async () => {
    const db = fakeDatabase(() => ({
      kind: 'ok',
      materials: [material],
      contentRevision: '5'
    }));
    const result = await mutateMaterials(
      parseMutateCommand({
        teamId: TEAM,
        action: 'move',
        materialIds: [FILE],
        targetFolderId: FOLDER
      }),
      deps(db.rpc)
    );
    expect(result).toEqual({ materials: [material], contentRevision: '5' });
    expect(db.permissions).toEqual(['edit']);
    expect(db.rpc).toHaveBeenCalledWith('service_mutate_space_materials', {
      p_actor: ACTOR,
      p_team: TEAM,
      p_input: {
        action: 'move',
        materialIds: [FILE],
        expectedRevisions: {},
        targetFolderId: FOLDER
      }
    });
  });

  it('a stale revision is REVISION_CONFLICT with the current one, and nothing else', async () => {
    const db = fakeDatabase(() => ({
      kind: 'conflict',
      materialId: FILE,
      currentRevision: '2'
    }));
    const error = await mutateMaterials(
      parseMutateCommand({
        teamId: TEAM,
        action: 'rename',
        materialIds: [FILE],
        name: 'Stale',
        expectedRevision: '1'
      }),
      deps(db.rpc)
    ).catch(cause => cause as TeamFunctionError);
    expect((error as TeamFunctionError).code).toBe('REVISION_CONFLICT');
    expect((error as TeamFunctionError).status).toBe(409);
    expect((error as TeamFunctionError).details).toEqual({ currentRevision: '2' });
  });

  it('a role without delete cannot trash, and the database is not asked', async () => {
    const db = fakeDatabase(() => {
      throw new Error('must not be called');
    });
    await expect(
      mutateMaterials(
        parseMutateCommand({ teamId: TEAM, action: 'trash', materialIds: [FILE] }),
        deps(db.rpc)
      )
    ).rejects.toThrow('PERMISSION_DENIED');
    await expect(emptyTrash({ teamId: TEAM, materialIds: null }, deps(db.rpc))).rejects.toThrow(
      'PERMISSION_DENIED'
    );
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual([
      'service_space_storage_context',
      'service_space_storage_context'
    ]);
  });

  it('a cycle the database refuses is INVALID_INPUT', async () => {
    const db = fakeDatabase(() => {
      throw { message: 'INVALID_INPUT', code: '22023' };
    });
    await expect(
      mutateMaterials(
        parseMutateCommand({
          teamId: TEAM,
          action: 'move',
          materialIds: [FOLDER],
          targetFolderId: FOLDER
        }),
        deps(db.rpc)
      )
    ).rejects.toThrow('INVALID_INPUT');
  });

  it('an answer the contract does not know is not passed on', async () => {
    const db = fakeDatabase(() => ({
      kind: 'ok',
      materials: [{ ...material, kind: 'shortcut' }],
      contentRevision: '5'
    }));
    await expect(
      mutateMaterials(
        parseMutateCommand({
          teamId: TEAM,
          action: 'copy',
          materialIds: [FILE],
          targetFolderId: FOLDER
        }),
        deps(db.rpc)
      )
    ).rejects.toThrow('INVALID_RESPONSE');
  });
});

describe('emptying the trash', () => {
  it('reports what went and what is queued for deletion', async () => {
    let allowDelete = true;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'service_space_storage_context')
        return {
          member: true,
          storageBackend: 'r2',
          storagePilot: false,
          actorPilot: false,
          workspaceAllowed: true,
          archived: false,
          allowed: allowDelete && args.p_permission === 'delete',
          accessEpoch: '0',
          contentRevision: '4',
          rootMaterialId: ROOT
        };
      expect(args).toEqual({ p_actor: ACTOR, p_team: TEAM, p_ids: [FILE] });
      return { deleted: 3, purgesQueued: 1, contentRevision: '6' };
    });
    expect(
      await emptyTrash(
        parseTrashEmptyCommand({ teamId: TEAM, materialIds: [FILE, FILE] }),
        deps(rpc)
      )
    ).toEqual({ deleted: 3, purgesQueued: 1, contentRevision: '6' });
    allowDelete = false;
  });
});

describe('reading materials not listed yet', () => {
  it('answers snapshots for view, and refuses what the contract does not know', async () => {
    const db = fakeDatabase((name, args) => {
      expect(name).toBe('service_read_space_materials');
      expect(args).toEqual({ p_actor: ACTOR, p_team: TEAM, p_ids: [FILE] });
      return [material];
    });
    expect(
      await readMaterials(
        parseReadMaterialsCommand({ teamId: TEAM, materialIds: [FILE, FILE] }),
        deps(db.rpc)
      )
    ).toEqual({ materials: [material] });
    expect(db.permissions).toEqual(['view']);
    expect(() => parseReadMaterialsCommand({ teamId: TEAM, materialIds: [] })).toThrow(
      'INVALID_INPUT'
    );
    const bad = fakeDatabase(() => [{ ...material, contentId: null }]);
    await expect(
      readMaterials({ teamId: TEAM, materialIds: [FILE] }, deps(bad.rpc))
    ).rejects.toThrow('INVALID_RESPONSE');
  });
});
