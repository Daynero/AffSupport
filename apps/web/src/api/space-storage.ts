import {
  BUILD_ID,
  SPACE_DERIVATIVE_RECIPE_VERSION,
  SPACE_STORAGE_CAPABILITY,
  SPACE_STORAGE_CAPABILITY_HEADER,
  formatByteCount,
  isSpaceContentId,
  isSpaceDerivativeVariant,
  isSpaceUuid,
  parseByteCount,
  parseCatalogStorageBreakdown,
  parseSpaceAdmitResult,
  parseSpaceDerivativeUrls,
  parseSpaceMaterialSnapshot,
  parseSpaceMutationResult,
  parseSpacePartUrls,
  parseSpaceReadGrantResult,
  parseSpaceStorageItemsPage,
  parseSpaceStorageSummary,
  parseSpaceTrashEmptied,
  parseTeamProcessStartResult,
  parseTeamRestitchDefaults,
  parseTeamTransferGrant,
  spaceFilesUrl
} from '@video-compressor/shared';
import type {
  AppEnvironment,
  CatalogStorageBreakdown,
  SpaceAdmitResult,
  SpaceDerivativeDeclaration,
  SpaceDerivativeUrl,
  SpaceDerivativeVariant,
  SpaceIngress,
  SpaceMaterialSnapshot,
  SpaceMutationResult,
  SpaceParsed,
  SpacePartUrl,
  SpaceReadGrantResult,
  SpaceStorageCategory,
  SpaceStorageItemSort,
  SpaceStorageItemsPage,
  SpaceStorageSummary,
  SpaceTrashEmptied,
  StorageBackend,
  TeamProcessStartResult,
  TeamRestitchDefaults,
  TeamTransferGrant
} from '@video-compressor/shared';
import { builtForEnvironment, type SiteChannel } from '../lib/config';
import { privateCacheActorEpoch, registerPrivateCache } from '../team/private-cache-scope';
// A cycle, as with `team-catalog-video-r2`: `team.ts` routes to this module and this module
// calls through `team.ts`'s transport. Neither touches the other while it is being loaded.
import {
  invokeTeamFunction,
  TeamApiError,
  untypedTeamRpc,
  type TeamProcessStartInput
} from './team';

/** A read through PostgREST, parsed or refused as INVALID_RESPONSE (never a guess). */
async function readRpc<T>(
  name: string,
  args: Record<string, unknown>,
  parse: (value: unknown) => SpaceParsed<T>
): Promise<T> {
  const value = await untypedTeamRpc(name, args);
  const parsed = parse(Array.isArray(value) && value.length === 1 ? value[0] : value);
  if (!parsed.ok) throw new TeamApiError('INVALID_RESPONSE', false);
  return parsed.value;
}

/**
 * 057: the web's side of Soty spaces on R2 (the `space-storage` edge function).
 *
 * Every request declares `storage-r2/1`, so the server can tell an old client to update instead
 * of serving it, and names the build for the journal. The client never names a bucket, a key or
 * a storage URL. Creation is called through `teamApi.createR2Space`; the transfer routes
 * (uploads, mutations, read grants) are below, and `team.ts` routes a space's file operations
 * here when `spaceBackendOf` says the space is on R2 (T029).
 */
export function spaceStorageRequestHeaders(): Record<string, string> {
  return {
    [SPACE_STORAGE_CAPABILITY_HEADER]: SPACE_STORAGE_CAPABILITY,
    'x-soty-client': `web/${BUILD_ID}`
  };
}

/**
 * Where «On R2» may be offered at all (US11, FR-052/FR-053): on the `next` address to a pilot,
 * never on the production address. Any other address of a non-production stack (beta, a
 * developer's machine) offers it to a pilot too, because the pilot is proven there before it
 * reaches `next`; the Agent's own copy of the production site does not.
 */
export function r2SpaceCreationAvailable(input: {
  channel: SiteChannel;
  environment: AppEnvironment;
  pilot: boolean;
}): boolean {
  if (!input.pilot || input.channel === 'production') return false;
  return input.channel === 'next' || input.environment !== 'production';
}

/**
 * Whether the team lists may show R2 spaces: everywhere except the production address, where
 * the old list keeps them out so an account with a pilot space sees nothing new (FR-053).
 */
export function listsR2Spaces(channel: SiteChannel): boolean {
  return channel !== 'production';
}

/**
 * How this bundle reads a read grant. The server names where reads go (`filesOrigin`): the
 * files host, or — on a beta stack, whose API the files host cannot reach — the local read
 * route of `space-storage`. Only a bundle built for beta follows the latter; a production
 * build refuses it as an invalid answer, so a misconfigured server cannot steer it there.
 */
export function readGrantParser(
  environment: AppEnvironment
): (value: unknown) => SpaceParsed<SpaceReadGrantResult> {
  const allowLocalRoute = environment !== 'production';
  return value => parseSpaceReadGrantResult(value, { allowLocalRoute });
}

// Which spaces live on R2 (T029) ----------------------------------------------------------

/**
 * Where each space the client has seen keeps its files, filled by `mapTeamContext` from every
 * team snapshot (the v2 list, a created space). Unknown means Drive: the old list only ever
 * returns Drive spaces, so a Drive space never depends on this registry being filled.
 */
const backends = new Map<string, StorageBackend>();
/** The root folder of an R2 space, when a snapshot or a root listing has named it. */
const roots = new Map<string, string>();

export function rememberSpaceBackend(teamId: string, backend: StorageBackend): void {
  backends.set(teamId, backend);
}

export function spaceBackendOf(teamId: string): StorageBackend {
  return backends.get(teamId) ?? 'drive';
}

export function isR2Space(teamId: string): boolean {
  return spaceBackendOf(teamId) === 'r2';
}

export function rememberSpaceRoot(teamId: string, rootMaterialId: string): void {
  if (isSpaceUuid(rootMaterialId)) roots.set(teamId, rootMaterialId);
}

/**
 * The root's material id, or null when this client has not been told it. The server reads a
 * null parent or target as the space root (it holds `storage_root_material_id` itself).
 */
export function spaceRootOf(teamId: string): string | null {
  return roots.get(teamId) ?? null;
}

/** What the files host needs to read a material, as the lists and snapshots last said it. */
export interface SpaceMaterialFacts {
  contentId: string | null;
  mimeType: string | null;
  name: string | null;
  materialRevision: string | null;
  thumbnailReady: boolean;
  /** The original's size, for the browser to choose how to save it (T051). */
  sizeBytes: number | null;
}

const MAX_REMEMBERED_MATERIALS = 50_000;
const materials = new Map<string, SpaceMaterialFacts>();
const materialKey = (teamId: string, materialId: string) => `${teamId}:${materialId}`;

function field(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

/**
 * Remembers rows of an R2 space: from a folder page, a subtree, an upload's commit or a
 * mutation's snapshot. Reads both the RPC's snake case and the function's camel case, and keeps
 * what an earlier row said for any field a later one leaves out.
 */
export function rememberSpaceMaterials(teamId: string, rows: readonly unknown[]): void {
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string') continue;
    const key = materialKey(teamId, row.id);
    const previous = materials.get(key);
    const contentId = field(row, 'contentId', 'content_id');
    const mimeType = field(row, 'mimeType', 'mime_type');
    const revision = field(row, 'materialRevision', 'material_revision');
    const ready = field(row, 'thumbnailReady', 'thumbnail_ready');
    const size = field(row, 'sizeBytes', 'size_bytes');
    const sizeBytes =
      typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
        ? size
        : typeof size === 'string' && parseByteCount(size) !== null
          ? Number(size)
          : null;
    materials.delete(key);
    materials.set(key, {
      contentId: isSpaceContentId(contentId) ? contentId : (previous?.contentId ?? null),
      mimeType: typeof mimeType === 'string' ? mimeType : (previous?.mimeType ?? null),
      name: typeof row.name === 'string' ? row.name : (previous?.name ?? null),
      materialRevision:
        typeof revision === 'string' && parseByteCount(revision) !== null
          ? revision
          : typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
            ? String(revision)
            : (previous?.materialRevision ?? null),
      thumbnailReady: typeof ready === 'boolean' ? ready : (previous?.thumbnailReady ?? false),
      sizeBytes: sizeBytes ?? previous?.sizeBytes ?? null
    });
  }
  while (materials.size > MAX_REMEMBERED_MATERIALS) {
    const oldest = materials.keys().next().value;
    if (oldest === undefined) break;
    materials.delete(oldest);
  }
}

export function spaceMaterialOf(teamId: string, materialId: string): SpaceMaterialFacts | null {
  return materials.get(materialKey(teamId, materialId)) ?? null;
}

// Routes of `space-storage` (T029) ---------------------------------------------------------

/** One route, called the way every team function is, and its answer read by a shared parser. */
async function callSpaceStorage<T>(
  route: string,
  body: Record<string, unknown>,
  parse: (value: unknown) => SpaceParsed<T>,
  signal?: AbortSignal
): Promise<T> {
  let parsed: T | undefined;
  await invokeTeamFunction(
    `space-storage/${route}`,
    body,
    (value): value is unknown => {
      const result = parse(value);
      if (result.ok) parsed = result.value;
      return result.ok;
    },
    { headers: spaceStorageRequestHeaders(), ...(signal ? { signal } : {}) }
  );
  return parsed as T;
}

export type SpaceCatalogVariantRun =
  | { state: 'registered'; index: number; outputMaterialId: string }
  /** `background`: the member's delegated agent holds it (057 T107); the page waits. */
  | { state: 'failed' | 'canceled' | 'background'; index: number }
  | {
      state: 'run';
      index: number;
      operationId: string;
      sourceGrant: TeamTransferGrant;
      finalizeGrant: TeamTransferGrant;
      defaults: TeamRestitchDefaults;
    };

/** The answer of `/catalog-variants/run`, checked to be for the variation that was asked. */
export function parseSpaceCatalogVariantRun(
  value: unknown,
  index: number
): SpaceCatalogVariantRun | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.index !== index) return null;
  if (row.state === 'registered')
    return isSpaceUuid(row.outputMaterialId)
      ? { state: 'registered', index, outputMaterialId: row.outputMaterialId }
      : null;
  if (row.state === 'failed' || row.state === 'canceled' || row.state === 'background')
    return { state: row.state, index };
  if (row.state !== 'run' || !isSpaceUuid(row.operationId)) return null;
  const sourceGrant = parseTeamTransferGrant(row.sourceGrant);
  const finalizeGrant = parseTeamTransferGrant(row.finalizeGrant);
  const defaults = parseTeamRestitchDefaults(row.defaults);
  if (
    sourceGrant?.purpose !== 'process_input' ||
    finalizeGrant?.purpose !== 'finalize' ||
    !defaults.ok
  )
    return null;
  return {
    state: 'run',
    index,
    operationId: row.operationId,
    sourceGrant,
    finalizeGrant,
    defaults: defaults.value
  };
}

export interface SpaceAdmitInput {
  teamId: string;
  /** Null for the space root. */
  parentMaterialId: string | null;
  name: string;
  contentType: string;
  bytes: number;
  contentId: string;
  ingress: SpaceIngress;
  idempotencyKey: string;
}

/** A picture job for this member's agent, as `/derivatives/claim` answers it (T047). */
export interface SpaceDerivativeJob {
  teamId: string;
  objectId: string;
  recipeVersion: number;
  reason: 'browser_unsupported' | 'missing_media_facts' | 'client_skipped';
  materialId: string;
  name: string;
  category: string | null;
  contentId: string;
  contentType: string;
  bytes: string;
  made: SpaceDerivativeVariant[];
  needsMediaFacts: boolean;
  leaseToken: string;
  leaseUntil: string;
  source: TeamTransferGrant;
}

export function parseSpaceDerivativeJob(value: unknown): SpaceDerivativeJob | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const source = parseTeamTransferGrant(row.source);
  if (
    !isSpaceUuid(row.teamId) ||
    !isSpaceUuid(row.objectId) ||
    !isSpaceUuid(row.materialId) ||
    row.recipeVersion !== SPACE_DERIVATIVE_RECIPE_VERSION ||
    (row.reason !== 'browser_unsupported' &&
      row.reason !== 'missing_media_facts' &&
      row.reason !== 'client_skipped') ||
    typeof row.name !== 'string' ||
    (row.category !== null && typeof row.category !== 'string') ||
    !isSpaceContentId(row.contentId) ||
    typeof row.contentType !== 'string' ||
    parseByteCount(row.bytes) === null ||
    !Array.isArray(row.made) ||
    !row.made.every(isSpaceDerivativeVariant) ||
    typeof row.needsMediaFacts !== 'boolean' ||
    typeof row.leaseToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(row.leaseToken) ||
    typeof row.leaseUntil !== 'string' ||
    source?.purpose !== 'download_range'
  )
    return null;
  return {
    teamId: row.teamId,
    objectId: row.objectId,
    recipeVersion: row.recipeVersion,
    reason: row.reason,
    materialId: row.materialId,
    name: row.name,
    category: row.category as string | null,
    contentId: row.contentId,
    contentType: row.contentType,
    bytes: row.bytes as string,
    made: [...row.made],
    needsMediaFacts: row.needsMediaFacts,
    leaseToken: row.leaseToken,
    leaseUntil: row.leaseUntil,
    source
  };
}

export const spaceStorageApi = {
  /** 057 T053: the scale — capacity, used, reserved and the six segments (US9.1). */
  storageSummary(teamId: string): Promise<SpaceStorageSummary> {
    return readRpc('get_space_storage_summary', { p_team: teamId }, parseSpaceStorageSummary);
  },

  /** One page of a category's things, biggest first or by date or author (US9.2). */
  storageItems(input: {
    teamId: string;
    category: SpaceStorageCategory;
    sort: SpaceStorageItemSort;
    search?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<SpaceStorageItemsPage> {
    return readRpc(
      'list_space_storage_items',
      {
        p_team: input.teamId,
        p_category: input.category,
        p_sort: input.sort,
        p_search: input.search?.trim() ? input.search.trim() : null,
        p_cursor: input.cursor ?? null,
        p_limit: input.limit ?? 50
      },
      parseSpaceStorageItemsPage
    );
  },

  /** What a catalog takes, what of it is shared and stays, what deleting it frees (US9.3). */
  catalogStorage(catalogId: string): Promise<CatalogStorageBreakdown> {
    return readRpc(
      'get_catalog_storage_breakdown',
      { p_catalog: catalogId },
      parseCatalogStorageBreakdown
    );
  },

  admitUpload(input: SpaceAdmitInput, signal?: AbortSignal): Promise<SpaceAdmitResult> {
    return callSpaceStorage(
      'uploads/admit',
      {
        teamId: input.teamId,
        parentMaterialId: input.parentMaterialId,
        name: input.name,
        contentType: input.contentType,
        bytes: formatByteCount(BigInt(input.bytes)),
        contentId: input.contentId,
        sha256: null,
        derivatives: [],
        ingress: input.ingress,
        idempotencyKey: input.idempotencyKey
      },
      parseSpaceAdmitResult,
      signal
    );
  },

  partUrls(
    teamId: string,
    uploadId: string,
    parts: readonly { partNumber: number; md5: string }[],
    signal?: AbortSignal
  ): Promise<SpacePartUrl[]> {
    return callSpaceStorage(
      `uploads/${encodeURIComponent(uploadId)}/parts`,
      { teamId, parts: parts.map(part => ({ partNumber: part.partNumber, md5: part.md5 })) },
      parseSpacePartUrls,
      signal
    );
  },

  completeUpload(
    teamId: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[]
  ): Promise<SpaceMaterialSnapshot> {
    return callSpaceStorage(
      `uploads/${encodeURIComponent(uploadId)}/complete`,
      { teamId, parts: parts.map(part => ({ partNumber: part.partNumber, etag: part.etag })) },
      parseSpaceMaterialSnapshot
    );
  },

  /**
   * What the browser made of the file it is uploading (T047): one signed PUT per declared
   * derivative, to a staging key. Declared while the session is open; checked at complete.
   */
  declareDerivatives(
    teamId: string,
    uploadId: string,
    input: {
      derivatives: readonly SpaceDerivativeDeclaration[];
      media: { durationMs: number | null; width: number | null; height: number | null } | null;
      unsupported: boolean;
    },
    signal?: AbortSignal
  ): Promise<SpaceDerivativeUrl[]> {
    return callSpaceStorage(
      `uploads/${encodeURIComponent(uploadId)}/derivatives`,
      {
        teamId,
        derivatives: input.derivatives.map(item => ({ ...item })),
        ...(input.media ? { media: { ...input.media } } : {}),
        unsupported: input.unsupported
      },
      parseSpaceDerivativeUrls,
      signal
    );
  },

  /**
   * One open picture job of the space for this member's own agent (T047): a lease and a source
   * ticket, or null when nothing waits. The lease token is a secret, never logged.
   */
  claimDerivativeJob(teamId: string): Promise<SpaceDerivativeJob | null> {
    return callSpaceStorage<SpaceDerivativeJob | null>('derivatives/claim', { teamId }, value => {
      if (!value || typeof value !== 'object') return { ok: false };
      const job = (value as { job?: unknown }).job;
      if (job === null) return { ok: true, value: null };
      const parsed = parseSpaceDerivativeJob(job);
      return parsed ? { ok: true, value: parsed } : { ok: false };
    });
  },

  abortUpload(teamId: string, uploadId: string): Promise<{ aborted: true }> {
    return callSpaceStorage<{ aborted: true }>(
      `uploads/${encodeURIComponent(uploadId)}/abort`,
      { teamId },
      value =>
        value && typeof value === 'object' && (value as { aborted?: unknown }).aborted === true
          ? { ok: true, value: { aborted: true as const } }
          : { ok: false }
    );
  },

  /**
   * A tool run in an R2 space (T035): the same grants drive-ops answers, opened by space-storage.
   * The caller (`teamApi.startProcess`) records the run so the agent is handed R2 endpoints.
   */
  startProcess(input: TeamProcessStartInput): Promise<TeamProcessStartResult> {
    return callSpaceStorage<TeamProcessStartResult>('process/start', { ...input }, value => {
      const parsed = parseTeamProcessStartResult(value);
      return parsed ? { ok: true, value: parsed } : { ok: false };
    });
  },

  /**
   * 057 T100: one re-stitched variation of a catalog being created in an R2 space, handed to this
   * member's agent. The server opens (or finds) the variation's run and answers its two tickets
   * with the settings the set froze — or that it is already made, or cannot be made any more.
   */
  runCatalogVariant(input: {
    teamId: string;
    setId: string;
    index: number;
    toolContractVersion: number;
  }): Promise<SpaceCatalogVariantRun> {
    return callSpaceStorage<SpaceCatalogVariantRun>('catalog-variants/run', { ...input }, value => {
      const parsed = parseSpaceCatalogVariantRun(value, input.index);
      return parsed ? { ok: true, value: parsed } : { ok: false };
    });
  },

  /** A ticket for the agent to save one R2 file (T033); the web builds the agent's address. */
  agentDownloadGrant(
    teamId: string,
    materialId: string
  ): Promise<{ fileName: string; grant: TeamTransferGrant }> {
    return callSpaceStorage<{ fileName: string; grant: TeamTransferGrant }>(
      'materials/agent-grant',
      { teamId, materialId },
      value => {
        if (!value || typeof value !== 'object') return { ok: false };
        const record = value as { fileName?: unknown; grant?: unknown };
        const grant = parseTeamTransferGrant(record.grant);
        return grant?.purpose === 'download_range' && typeof record.fileName === 'string'
          ? { ok: true, value: { fileName: record.fileName, grant } }
          : { ok: false };
      }
    );
  },

  async mutate(input: SpaceMutationInput): Promise<SpaceMutationResult> {
    const result = await callSpaceStorage(
      'materials/mutate',
      { ...input },
      parseSpaceMutationResult
    );
    rememberSpaceMaterials(input.teamId, result.materials);
    return result;
  },

  /** Snapshots of materials this client has not listed; they are remembered for reads. */
  async readMaterials(
    teamId: string,
    materialIds: readonly string[]
  ): Promise<SpaceMaterialSnapshot[]> {
    const materials = await callSpaceStorage<SpaceMaterialSnapshot[]>(
      'materials/read',
      { teamId, materialIds: [...materialIds] },
      value => {
        if (
          !value ||
          typeof value !== 'object' ||
          !Array.isArray((value as { materials?: unknown }).materials)
        )
          return { ok: false };
        const parsed: SpaceMaterialSnapshot[] = [];
        for (const item of (value as { materials: unknown[] }).materials) {
          const one = parseSpaceMaterialSnapshot(item);
          if (!one.ok) return { ok: false };
          parsed.push(one.value);
        }
        return { ok: true, value: parsed };
      }
    );
    rememberSpaceMaterials(teamId, materials);
    return materials;
  },

  emptyTrash(teamId: string, materialIds?: readonly string[]): Promise<SpaceTrashEmptied> {
    return callSpaceStorage(
      'trash/empty',
      { teamId, ...(materialIds ? { materialIds: [...materialIds] } : {}) },
      parseSpaceTrashEmptied
    );
  },

  /**
   * The space's read grant, shared by every read of the space until a minute before it runs
   * out. `refresh` asks again — what a 401 from the files host calls for, once. The grant is
   * never logged, nor any URL that carries it.
   */
  readGrant(teamId: string, options: { refresh?: boolean } = {}): Promise<SpaceReadGrantResult> {
    const cached = grants.get(teamId);
    if (!options.refresh && cached && cached.freshUntil > Date.now()) return cached.promise;
    const promise = callSpaceStorage(
      'read-grant',
      { teamId },
      readGrantParser(builtForEnvironment())
    );
    const entry = { promise, freshUntil: Number.POSITIVE_INFINITY };
    grants.set(teamId, entry);
    promise.then(
      grant => {
        if (grants.get(teamId) === entry)
          entry.freshUntil = Date.parse(grant.expiresAt) - READ_GRANT_REFRESH_MARGIN_MS;
      },
      () => {
        if (grants.get(teamId) === entry) grants.delete(teamId);
      }
    );
    return promise;
  }
};

export type SpaceMutationInput =
  | {
      teamId: string;
      action: 'rename';
      materialIds: [string];
      name: string;
      expectedRevision?: string;
    }
  | {
      teamId: string;
      action: 'move' | 'copy';
      materialIds: string[];
      targetFolderId: string | null;
    }
  | {
      teamId: string;
      action: 'create_folder';
      parentMaterialId: string | null;
      name: string;
      ensure?: true;
    }
  | { teamId: string; action: 'trash' | 'restore'; materialIds: string[] };

const READ_GRANT_REFRESH_MARGIN_MS = 60_000;
const grants = new Map<string, { promise: Promise<SpaceReadGrantResult>; freshUntil: number }>();

/** Everything this module remembers (tests, and a full reset). */
export function clearSpaceStorageCaches(): void {
  grants.clear();
  backends.clear();
  roots.clear();
  materials.clear();
}

/*
 * A grant is the person's: any change of scope drops it. What a material is called and holds is
 * kept across a same-person access refresh, which re-reads no folder, and dropped with the
 * account. Where a space keeps its files never changes, so it is kept.
 */
let materialsActorEpoch = privateCacheActorEpoch();
registerPrivateCache(() => {
  grants.clear();
  if (privateCacheActorEpoch() === materialsActorEpoch) return;
  materialsActorEpoch = privateCacheActorEpoch();
  materials.clear();
});

/** A material's URL on the files host: its original, its `tile`, or a download of it. */
export async function spaceMaterialUrl(input: {
  teamId: string;
  materialId: string;
  derivative?: SpaceDerivativeVariant;
  download?: string;
  /** A read was refused with the grant in hand (401): ask for a new one, once. */
  freshGrant?: boolean;
}): Promise<{ url: string; expiresAt: string; facts: SpaceMaterialFacts }> {
  let facts = spaceMaterialOf(input.teamId, input.materialId);
  if (!facts?.contentId) {
    // Not listed yet on this page (a task attachment, a search hit): ask the space once.
    await spaceStorageApi.readMaterials(input.teamId, [input.materialId]);
    facts = spaceMaterialOf(input.teamId, input.materialId);
  }
  if (!facts?.contentId) throw new TeamApiError('NOT_FOUND', false);
  const grant = await spaceStorageApi.readGrant(
    input.teamId,
    input.freshGrant ? { refresh: true } : {}
  );
  return {
    url: spaceFilesUrl({
      filesOrigin: grant.filesOrigin,
      teamId: input.teamId,
      contentId: facts.contentId,
      grant: grant.grant,
      ...(input.derivative
        ? {
            derivative: {
              recipeVersion: SPACE_DERIVATIVE_RECIPE_VERSION,
              variant: input.derivative
            }
          }
        : {}),
      ...(input.download !== undefined ? { download: input.download } : {})
    }),
    expiresAt: grant.expiresAt,
    facts
  };
}
