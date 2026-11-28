// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 057 T028 — the explorer's file operations behind one seam. A Drive space calls exactly what it
 * called before 057 (the literal lists below are a snapshot of the code as it stood when this
 * test was written); an R2 space never reaches `drive-ops` or `drive-transfer`.
 *
 * The fake transport records every function, RPC and fetch the web client makes.
 */

const transport = vi.hoisted(() => ({
  calls: [] as string[],
  bodies: [] as { name: string; body: Record<string, unknown>; headers: Record<string, string> }[],
  puts: [] as { url: string; headers: Record<string, string>; bytes: number }[],
  functions: new Map<string, (body: Record<string, unknown>) => unknown>(),
  rpcs: new Map<string, (args: Record<string, unknown>) => unknown>(),
  fetches: [] as ((url: URL, init: RequestInit) => Response | null)[]
}));

vi.mock('../apps/web/src/lib/config', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/config')>()),
  publicConfig: {
    ok: true,
    value: {
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: 'publishable',
      environment: 'beta'
    }
  },
  siteChannel: () => 'next'
}));
vi.mock('../apps/web/src/lib/supabase', async importOriginal => {
  const client = {
    functions: {
      invoke: async (
        name: string,
        options: { body?: Record<string, unknown>; headers?: Record<string, string> }
      ) => {
        const body = options.body ?? {};
        const tag = name === 'drive-transfer' ? `#${String(body.action ?? body.mode)}` : '';
        transport.calls.push(`function:${name}${tag}`);
        transport.bodies.push({ name, body, headers: options.headers ?? {} });
        const respond = [...transport.functions.entries()].find(([prefix]) =>
          name.startsWith(prefix)
        )?.[1];
        if (!respond) throw new Error(`unexpected function ${name}`);
        return { data: { ok: true, value: respond(body) }, error: null };
      }
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      transport.calls.push(`rpc:${name}`);
      const respond = transport.rpcs.get(name);
      if (!respond) throw new Error(`unexpected rpc ${name}`);
      return { data: respond(args), error: null };
    },
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) }
  };
  return {
    ...(await importOriginal<typeof import('../apps/web/src/lib/supabase')>()),
    withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
    requireSupabaseClient: () => client,
    getSupabaseClient: () => client
  };
});

import {
  SPACE_DERIVATIVE_RECIPE_VERSION,
  spaceContentId,
  spaceFilesUrl,
  spaceMd5Base64,
  spaceMd5Hex
} from '@video-compressor/shared';
import { teamApi } from '../apps/web/src/api/team';
import {
  clearSpaceStorageCaches,
  rememberSpaceMaterials,
  spaceBackendOf
} from '../apps/web/src/api/space-storage';
import { uploadTeamFile } from '../apps/web/src/team/catalog/material-actions-client';

const id = (n: number) => `05728000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DRIVE_TEAM = id(1);
const R2_TEAM = id(2);
const MATERIAL = id(3);
const FOLDER = id(4);
const UPLOAD = id(5);
const ROOT = id(6);
const ACTOR = id(7);
const CONTENT = 'c'.repeat(64);
const FILES_ORIGIN = 'https://files-beta.soty.pp.ua';
const GRANT = 'grant_abcdefghijklmnop';
const FUTURE = '2099-01-01T00:00:00.000Z';
const ALL = {
  view: true,
  download: true,
  upload: true,
  edit: true,
  delete: true,
  process: true,
  manage_members: true,
  manage_metadata: true
};

const operation = { operationId: 'op-1', state: 'succeeded', materialId: MATERIAL, reused: false };

function stubFetch() {
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    transport.calls.push(`fetch:${method} ${url.host}${url.pathname}`);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (method === 'PUT') {
      const bytes = init.body instanceof Blob ? init.body.size : 0;
      transport.puts.push({ url: url.toString(), headers, bytes });
    }
    for (const respond of transport.fetches) {
      const response = respond(url, init);
      if (response) return response;
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  });
}

function driveResponders() {
  transport.functions.set('drive-ops/uploads/start', body => ({
    operationId: 'op-1',
    state: 'pending',
    sessionUri: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=session',
    sessionUnavailable: false,
    name: body.name,
    chunkMultiple: 256 * 1024,
    expiresAt: null,
    relayUrl: null
  }));
  transport.functions.set('drive-ops/uploads/op-1/finalize', () => operation);
  for (const route of [
    'drive-ops/rename',
    'drive-ops/move',
    'drive-ops/copy',
    'drive-ops/trash-as-actor',
    'drive-ops/restore-as-actor'
  ])
    transport.functions.set(route, () => operation);
  for (const route of ['drive-ops/ensure-upload-folder', 'drive-ops/ensure-task-drop-folder'])
    transport.functions.set(route, () => ({
      folderId: 'drive-folder',
      materialId: FOLDER,
      name: 'Folder',
      created: true
    }));
  transport.functions.set('drive-transfer', body => {
    if (body.action === 'grant')
      return {
        kind: 'browser',
        rangeUrl: 'https://internal.example/functions/v1/drive-transfer/range?grant=1',
        expiresAt: FUTURE,
        disposition: 'attachment'
      };
    if (body.action === 'thumbnail_session')
      return {
        token: 'thumb',
        expiresAt: FUTURE,
        teamId: DRIVE_TEAM,
        endpoint: 'https://project.supabase.co/functions/v1/drive-transfer/thumbnail'
      };
    return {
      kind: 'media',
      rangeUrl: 'https://internal.example/functions/v1/drive-transfer/range?preview=1',
      mimeType: 'video/mp4',
      expiresAt: FUTURE
    };
  });
  transport.fetches.push(url =>
    url.pathname.endsWith('/relay')
      ? Response.json({ ok: true, value: { complete: true, driveFileId: 'drive-file' } })
      : null
  );
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: MATERIAL,
    teamId: R2_TEAM,
    parentMaterialId: FOLDER,
    name: 'clip.mp4',
    kind: 'file',
    lifecycle: 'active',
    materialRevision: '2',
    contentId: CONTENT,
    sizeBytes: '5',
    mimeType: 'video/mp4',
    ...overrides
  };
}

function folderSnapshot(name: string, parentMaterialId: string | null) {
  return snapshot({
    id: FOLDER,
    name,
    kind: 'folder',
    parentMaterialId,
    contentId: null,
    sizeBytes: null,
    mimeType: null
  });
}

function r2Responders() {
  transport.functions.set('space-storage/uploads/admit', () => ({
    kind: 'session',
    uploadId: UPLOAD,
    partBytes: 16 * 1024 * 1024,
    partCount: 1,
    derivativeSlots: [],
    expiresAt: FUTURE
  }));
  transport.functions.set(`space-storage/uploads/${UPLOAD}/parts`, body => ({
    parts: (body.parts as { partNumber: number }[]).map(part => ({
      partNumber: part.partNumber,
      url: `https://bucket.r2.example/staging?part=${part.partNumber}&sig=x`,
      expiresAt: FUTURE
    }))
  }));
  transport.functions.set(`space-storage/uploads/${UPLOAD}/complete`, () => snapshot());
  transport.functions.set(`space-storage/uploads/${UPLOAD}/abort`, () => ({ aborted: true }));
  transport.functions.set('space-storage/materials/mutate', body =>
    body.action === 'create_folder'
      ? {
          materials: [folderSnapshot(String(body.name), (body.parentMaterialId as string) ?? ROOT)],
          contentRevision: '9',
          ...(body.ensure ? { created: false } : {})
        }
      : {
          materials: [
            snapshot(body.action === 'trash' ? { lifecycle: 'trashed' } : {}),
            ...(body.action === 'copy' ? [snapshot({ id: id(8) })] : [])
          ],
          contentRevision: '9'
        }
  );
  transport.functions.set('space-storage/read-grant', () => ({
    grant: GRANT,
    expiresAt: FUTURE,
    filesOrigin: FILES_ORIGIN
  }));
  transport.fetches.push((url, init) =>
    url.host === 'bucket.r2.example' && init.method === 'PUT'
      ? new Response(null, {
          status: 200,
          headers: { ETag: `"${spaceMd5Hex(new TextEncoder().encode('hello'))}"` }
        })
      : null
  );
}

beforeEach(() => {
  transport.calls.length = 0;
  transport.bodies.length = 0;
  transport.puts.length = 0;
  transport.functions.clear();
  transport.rpcs.clear();
  transport.fetches.length = 0;
  clearSpaceStorageCaches();
  stubFetch();
  transport.rpcs.set('list_my_teams_v2', () => [
    {
      id: DRIVE_TEAM,
      name: 'Drive space',
      role: 'owner',
      permissions: ALL,
      connection_state: 'connected',
      storage_backend: 'drive'
    },
    {
      id: R2_TEAM,
      name: 'Soty space',
      role: 'owner',
      permissions: ALL,
      connection_state: 'none',
      storage_backend: 'r2'
    }
  ]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const file = () => new File(['hello'], 'clip.mp4', { type: 'video/mp4' });

/** Every explorer operation, run once against one space; returns what each one called. */
async function runEveryOperation(teamId: string) {
  const record = async (run: () => Promise<unknown>) => {
    transport.calls.length = 0;
    const value = await run();
    return { calls: [...transport.calls], value };
  };
  return {
    upload: await record(() =>
      uploadTeamFile({
        teamId,
        destinationFolderId: FOLDER,
        file: file(),
        conflictMode: 'keep_both',
        replaceMaterialId: null,
        versionOfMaterialId: null,
        idempotencyKey: 'upload-key-0000000001'
      })
    ),
    rename: await record(() =>
      teamApi.renameMaterial({
        teamId,
        materialId: MATERIAL,
        newName: 'renamed.mp4',
        conflictMode: 'cancel',
        idempotencyKey: 'rename-key'
      })
    ),
    move: await record(() =>
      teamApi.moveMaterial({
        teamId,
        materialId: MATERIAL,
        destinationFolderId: FOLDER,
        conflictMode: 'keep_both',
        idempotencyKey: 'move-key'
      })
    ),
    copy: await record(() =>
      teamApi.copyMaterial({
        teamId,
        materialId: MATERIAL,
        destinationFolderId: FOLDER,
        idempotencyKey: 'copy-key'
      })
    ),
    trash: await record(() =>
      teamApi.trashMaterial({
        teamId,
        materialId: MATERIAL,
        idempotencyKey: 'trash-key',
        expectedActorId: ACTOR
      })
    ),
    restore: await record(() =>
      teamApi.restoreMaterial({
        teamId,
        materialId: MATERIAL,
        idempotencyKey: 'restore-key',
        expectedActorId: ACTOR
      })
    ),
    download: await record(() => teamApi.requestDownload(teamId, MATERIAL, 'browser')),
    preview: await record(() => teamApi.previewMaterial(teamId, MATERIAL, 'media')),
    thumbnail: await record(async () => {
      const session = await teamApi.mintThumbnailSession(teamId);
      return teamApi.thumbnailUrl(session, MATERIAL);
    }),
    createFolder: await record(() =>
      teamApi.createFolder(teamId, { name: 'New folder', parentMaterialId: FOLDER })
    ),
    ensureUploadFolder: await record(() =>
      teamApi.ensureUploadFolder(teamId, { name: 'Dropped', parentMaterialId: FOLDER })
    )
  };
}

describe('a Drive space calls what it called before 057', () => {
  it('runs every operation through drive-ops and drive-transfer, unchanged', async () => {
    driveResponders();
    await teamApi.listTeams();
    expect(spaceBackendOf(DRIVE_TEAM)).toBe('drive');
    const ran = await runEveryOperation(DRIVE_TEAM);
    expect(
      Object.fromEntries(Object.entries(ran).map(([key, value]) => [key, value.calls]))
    ).toEqual({
      upload: [
        'function:drive-ops/uploads/start',
        'fetch:POST project.supabase.co/functions/v1/drive-ops/uploads/op-1/relay',
        'function:drive-ops/uploads/op-1/finalize'
      ],
      rename: ['function:drive-ops/rename'],
      move: ['function:drive-ops/move'],
      copy: ['function:drive-ops/copy'],
      trash: ['function:drive-ops/trash-as-actor'],
      restore: ['function:drive-ops/restore-as-actor'],
      download: ['function:drive-transfer#grant'],
      preview: ['function:drive-transfer#media'],
      thumbnail: ['function:drive-transfer#thumbnail_session'],
      createFolder: ['function:drive-ops/ensure-upload-folder'],
      ensureUploadFolder: ['function:drive-ops/ensure-upload-folder']
    });
    // The same answers as before, too: the grant is rewritten onto the public address.
    expect(ran.upload.value).toEqual(operation);
    expect(ran.download.value).toEqual({
      kind: 'browser',
      rangeUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range?grant=1',
      expiresAt: FUTURE,
      disposition: 'attachment'
    });
    expect(ran.thumbnail.value).toBe(
      `https://project.supabase.co/functions/v1/drive-transfer/thumbnail?material=${MATERIAL}&session=thumb`
    );
    // No Drive request declares the R2 capability.
    expect(transport.bodies.every(entry => !('x-soty-capabilities' in entry.headers))).toBe(true);
  });

  it('ensures the task drop folder through drive-ops, as before', async () => {
    driveResponders();
    await teamApi.ensureTaskDropFolder(DRIVE_TEAM);
    await teamApi.ensureTaskDropFolder(DRIVE_TEAM, { name: 'Sub', parentMaterialId: FOLDER });
    expect(transport.calls).toEqual([
      'function:drive-ops/ensure-task-drop-folder',
      'function:drive-ops/ensure-task-drop-folder'
    ]);
    expect(transport.bodies.map(entry => entry.body)).toEqual([
      { teamId: DRIVE_TEAM },
      { teamId: DRIVE_TEAM, name: 'Sub', parentMaterialId: FOLDER }
    ]);
  });
});

describe('an R2 space never reaches Drive', () => {
  it('runs every operation through space-storage and the files host', async () => {
    r2Responders();
    await teamApi.listTeams();
    expect(spaceBackendOf(R2_TEAM)).toBe('r2');
    rememberSpaceMaterials(R2_TEAM, [
      { id: MATERIAL, contentId: CONTENT, mimeType: 'video/mp4', thumbnailReady: false }
    ]);
    const ran = await runEveryOperation(R2_TEAM);
    const all = Object.values(ran).flatMap(value => value.calls);
    expect(all.some(call => call.includes('drive-ops') || call.includes('drive-transfer'))).toBe(
      false
    );
    expect(
      Object.fromEntries(Object.entries(ran).map(([key, value]) => [key, value.calls]))
    ).toEqual({
      upload: [
        'function:space-storage/uploads/admit',
        `function:space-storage/uploads/${UPLOAD}/parts`,
        'fetch:PUT bucket.r2.example/staging',
        `function:space-storage/uploads/${UPLOAD}/complete`
      ],
      rename: ['function:space-storage/materials/mutate'],
      move: ['function:space-storage/materials/mutate'],
      copy: ['function:space-storage/materials/mutate'],
      trash: ['function:space-storage/materials/mutate'],
      restore: ['function:space-storage/materials/mutate'],
      // One read grant, cached for the space until a minute before it runs out.
      download: ['function:space-storage/read-grant'],
      preview: [],
      thumbnail: [],
      createFolder: ['function:space-storage/materials/mutate'],
      ensureUploadFolder: ['function:space-storage/materials/mutate']
    });
    // Every space-storage request declares the capability.
    expect(
      transport.bodies.every(entry => entry.headers['x-soty-capabilities'] === 'storage-r2/1')
    ).toBe(true);
    expect(ran.upload.value).toEqual({
      operationId: 'upload-key-0000000001',
      state: 'succeeded',
      materialId: MATERIAL,
      reused: false
    });
    const original = spaceFilesUrl({
      filesOrigin: FILES_ORIGIN,
      teamId: R2_TEAM,
      contentId: CONTENT,
      grant: GRANT
    });
    expect(ran.download.value).toEqual({
      kind: 'browser',
      // The name as the last snapshot of the material carried it.
      fileName: 'clip.mp4',
      rangeUrl: spaceFilesUrl({
        filesOrigin: FILES_ORIGIN,
        teamId: R2_TEAM,
        contentId: CONTENT,
        grant: GRANT,
        download: 'clip.mp4'
      }),
      expiresAt: FUTURE,
      disposition: 'attachment'
    });
    expect(ran.preview.value).toEqual({
      kind: 'media',
      rangeUrl: original,
      mimeType: 'video/mp4',
      expiresAt: FUTURE
    });
    // No derivative yet (Phase 5): no tile, rather than a picture that will not load.
    expect(ran.thumbnail.value).toBeNull();
  });

  it('admits, signs, PUTs with Content-MD5 and completes with the part ETags', async () => {
    r2Responders();
    await teamApi.listTeams();
    const bytes = new TextEncoder().encode('hello');
    const progress: number[] = [];
    await uploadTeamFile({
      teamId: R2_TEAM,
      destinationFolderId: FOLDER,
      file: file(),
      conflictMode: 'keep_both',
      replaceMaterialId: null,
      versionOfMaterialId: null,
      idempotencyKey: 'upload-key-0000000002',
      onProgress: sent => progress.push(sent)
    });
    const md5 = spaceMd5Hex(bytes);
    const contentId = await spaceContentId(5, [md5]);
    const bodies = Object.fromEntries(transport.bodies.map(entry => [entry.name, entry.body]));
    expect(bodies['space-storage/uploads/admit']).toEqual({
      teamId: R2_TEAM,
      parentMaterialId: FOLDER,
      name: 'clip.mp4',
      contentType: 'video/mp4',
      bytes: '5',
      contentId: contentId.ok ? contentId.contentId : null,
      sha256: null,
      derivatives: [],
      ingress: 'explorer',
      idempotencyKey: 'upload-key-0000000002'
    });
    expect(bodies[`space-storage/uploads/${UPLOAD}/parts`]).toEqual({
      teamId: R2_TEAM,
      parts: [{ partNumber: 1, md5 }]
    });
    expect(transport.puts).toEqual([
      {
        url: 'https://bucket.r2.example/staging?part=1&sig=x',
        headers: { 'content-md5': spaceMd5Base64(bytes) },
        bytes: 5
      }
    ]);
    expect(bodies[`space-storage/uploads/${UPLOAD}/complete`]).toEqual({
      teamId: R2_TEAM,
      parts: [{ partNumber: 1, etag: md5 }]
    });
    expect(progress.at(-1)).toBe(5);
  });

  it('sends nothing when the same content is already in the folder', async () => {
    r2Responders();
    transport.functions.set('space-storage/uploads/admit', () => ({
      kind: 'exists',
      materialId: MATERIAL
    }));
    await teamApi.listTeams();
    const result = await uploadTeamFile({
      teamId: R2_TEAM,
      destinationFolderId: FOLDER,
      file: file(),
      conflictMode: 'keep_both',
      replaceMaterialId: null,
      versionOfMaterialId: null
    });
    expect(result).toMatchObject({ state: 'succeeded', materialId: MATERIAL, reused: true });
    expect(transport.calls).toEqual([
      'rpc:list_my_teams_v2',
      'function:space-storage/uploads/admit'
    ]);
  });

  it('re-signs a part R2 refused once, and aborts the session on cancel', async () => {
    r2Responders();
    await teamApi.listTeams();
    let refusals = 1;
    transport.fetches.unshift((url, init) =>
      url.host === 'bucket.r2.example' && init.method === 'PUT' && refusals-- > 0
        ? new Response(null, { status: 403 })
        : null
    );
    await uploadTeamFile({
      teamId: R2_TEAM,
      destinationFolderId: null,
      file: file(),
      conflictMode: 'keep_both',
      replaceMaterialId: null,
      versionOfMaterialId: null
    });
    expect(transport.calls.filter(call => call.endsWith('/parts'))).toHaveLength(2);
    expect(transport.calls.filter(call => call.startsWith('fetch:PUT'))).toHaveLength(2);

    transport.calls.length = 0;
    const controller = new AbortController();
    transport.fetches.unshift((url, init) => {
      if (url.host === 'bucket.r2.example' && init.method === 'PUT') controller.abort();
      return null;
    });
    await expect(
      uploadTeamFile({
        teamId: R2_TEAM,
        destinationFolderId: null,
        file: file(),
        conflictMode: 'keep_both',
        replaceMaterialId: null,
        versionOfMaterialId: null,
        signal: controller.signal
      })
    ).rejects.toBeTruthy();
    expect(transport.calls).toContain(`function:space-storage/uploads/${UPLOAD}/abort`);
    expect(transport.calls).not.toContain(`function:space-storage/uploads/${UPLOAD}/complete`);
  });

  it('maps the mutations onto materials/mutate with the shapes the server takes', async () => {
    r2Responders();
    await teamApi.listTeams();
    rememberSpaceMaterials(R2_TEAM, [{ id: MATERIAL, materialRevision: '4' }]);
    await teamApi.renameMaterial({
      teamId: R2_TEAM,
      materialId: MATERIAL,
      newName: 'b.mp4',
      conflictMode: 'cancel',
      idempotencyKey: 'k1'
    });
    await teamApi.moveMaterial({
      teamId: R2_TEAM,
      materialId: MATERIAL,
      destinationFolderId: FOLDER,
      conflictMode: 'keep_both',
      idempotencyKey: 'k2'
    });
    await teamApi.copyMaterial({
      teamId: R2_TEAM,
      materialId: MATERIAL,
      destinationFolderId: FOLDER,
      idempotencyKey: 'k3'
    });
    await teamApi.trashMaterial({ teamId: R2_TEAM, materialId: MATERIAL, idempotencyKey: 'k4' });
    await teamApi.restoreMaterial({ teamId: R2_TEAM, materialId: MATERIAL, idempotencyKey: 'k5' });
    await teamApi.createFolder(R2_TEAM, { name: 'Made', parentMaterialId: FOLDER });
    await teamApi.ensureUploadFolder(R2_TEAM, { name: 'Dropped', parentMaterialId: FOLDER });
    expect(
      transport.bodies
        .filter(entry => entry.name === 'space-storage/materials/mutate')
        .map(e => e.body)
    ).toEqual([
      {
        teamId: R2_TEAM,
        action: 'rename',
        materialIds: [MATERIAL],
        name: 'b.mp4',
        expectedRevision: '4'
      },
      { teamId: R2_TEAM, action: 'move', materialIds: [MATERIAL], targetFolderId: FOLDER },
      { teamId: R2_TEAM, action: 'copy', materialIds: [MATERIAL], targetFolderId: FOLDER },
      { teamId: R2_TEAM, action: 'trash', materialIds: [MATERIAL] },
      { teamId: R2_TEAM, action: 'restore', materialIds: [MATERIAL] },
      { teamId: R2_TEAM, action: 'create_folder', parentMaterialId: FOLDER, name: 'Made' },
      {
        teamId: R2_TEAM,
        action: 'create_folder',
        parentMaterialId: FOLDER,
        name: 'Dropped',
        ensure: true
      }
    ]);
  });

  it('shows a tile only once its derivative exists, and re-reads the grant near expiry', async () => {
    r2Responders();
    await teamApi.listTeams();
    rememberSpaceMaterials(R2_TEAM, [{ id: MATERIAL, contentId: CONTENT, thumbnailReady: true }]);
    const session = await teamApi.mintThumbnailSession(R2_TEAM);
    expect(teamApi.thumbnailUrl(session, MATERIAL)).toBe(
      spaceFilesUrl({
        filesOrigin: FILES_ORIGIN,
        teamId: R2_TEAM,
        contentId: CONTENT,
        grant: GRANT,
        derivative: { recipeVersion: SPACE_DERIVATIVE_RECIPE_VERSION, variant: 'tile' }
      })
    );
    // A material the client has not seen has no tile either.
    expect(teamApi.thumbnailUrl(session, id(99))).toBeNull();

    transport.functions.set('space-storage/read-grant', () => ({
      grant: GRANT,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      filesOrigin: FILES_ORIGIN
    }));
    clearSpaceStorageCaches();
    rememberSpaceMaterials(R2_TEAM, [{ id: MATERIAL, contentId: CONTENT }]);
    await teamApi.listTeams();
    transport.calls.length = 0;
    await teamApi.requestDownload(R2_TEAM, MATERIAL, 'browser');
    await teamApi.requestDownload(R2_TEAM, MATERIAL, 'browser');
    expect(transport.calls).toEqual([
      'function:space-storage/read-grant',
      'function:space-storage/read-grant'
    ]);
  });
});
