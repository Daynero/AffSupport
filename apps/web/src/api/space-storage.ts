import {
  BUILD_ID,
  SPACE_DERIVATIVE_RECIPE_VERSION,
  SPACE_STORAGE_CAPABILITY,
  SPACE_STORAGE_CAPABILITY_HEADER,
  SPACE_STORAGE_LIMITS,
  SpaceMd5,
  formatByteCount,
  isSpaceContentId,
  isSpaceUuid,
  normalizePartEtag,
  parseByteCount,
  parseSpaceAdmitResult,
  parseSpaceMaterialSnapshot,
  parseSpaceMutationResult,
  parseSpacePartUrls,
  parseSpaceReadGrantResult,
  parseSpaceTrashEmptied,
  parseTeamProcessStartResult,
  parseTeamRestitchDefaults,
  parseTeamTransferGrant,
  spaceContentId,
  spaceFilesUrl,
  spaceMd5HexToBase64,
  spacePartBytes,
  spacePartCount,
  spacePartRange
} from '@video-compressor/shared';
import type {
  AppEnvironment,
  SpaceAdmitResult,
  SpaceDerivativeVariant,
  SpaceIngress,
  SpaceMaterialSnapshot,
  SpaceMutationResult,
  SpaceParsed,
  SpacePartUrl,
  SpaceReadGrantResult,
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
import { invokeTeamFunction, TeamApiError, type TeamProcessStartInput } from './team';

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
      thumbnailReady: typeof ready === 'boolean' ? ready : (previous?.thumbnailReady ?? false)
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
  | { state: 'failed' | 'canceled'; index: number }
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
  if (row.state === 'failed' || row.state === 'canceled') return { state: row.state, index };
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

export const spaceStorageApi = {
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
}): Promise<{ url: string; expiresAt: string; facts: SpaceMaterialFacts }> {
  let facts = spaceMaterialOf(input.teamId, input.materialId);
  if (!facts?.contentId) {
    // Not listed yet on this page (a task attachment, a search hit): ask the space once.
    await spaceStorageApi.readMaterials(input.teamId, [input.materialId]);
    facts = spaceMaterialOf(input.teamId, input.materialId);
  }
  if (!facts?.contentId) throw new TeamApiError('NOT_FOUND', false);
  const grant = await spaceStorageApi.readGrant(input.teamId);
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

// Upload (T029) ----------------------------------------------------------------------------

/** A file, or a file the paired app reads for the browser in ranges. */
export type SpaceUploadSource =
  | Blob
  | {
      size: number;
      readChunk: (start: number, endExclusive: number, signal?: AbortSignal) => Promise<Blob>;
    };

/** How much of a part is read at a time to hash it, so a 64 MiB part is never held twice. */
const HASH_SLICE_BYTES = 4 * 1024 * 1024;
const UPLOAD_PARALLEL_PARTS = 4;
/** A signed part URL this close to its end is asked for again rather than tried. */
const PART_URL_MARGIN_MS = 30_000;

function readRange(
  source: SpaceUploadSource,
  start: number,
  endExclusive: number,
  signal?: AbortSignal
): Promise<Blob> {
  return source instanceof Blob
    ? Promise.resolve(source.slice(start, endExclusive))
    : source.readChunk(start, endExclusive, signal);
}

function canceled(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('CANCELED');
}

async function partMd5(
  source: SpaceUploadSource,
  range: { start: number; end: number },
  signal?: AbortSignal
): Promise<string> {
  const md5 = new SpaceMd5();
  for (let offset = range.start; offset <= range.end; offset += HASH_SLICE_BYTES) {
    if (signal?.aborted) throw canceled(signal);
    const end = Math.min(offset + HASH_SLICE_BYTES, range.end + 1);
    md5.update(new Uint8Array(await (await readRange(source, offset, end, signal)).arrayBuffer()));
  }
  return Array.from(md5.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface SpaceUploadInput {
  teamId: string;
  /** Null for the space root. */
  parentMaterialId: string | null;
  name: string;
  contentType: string;
  source: SpaceUploadSource;
  idempotencyKey: string;
  ingress?: SpaceIngress;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

export interface SpaceUploadResult {
  materialId: string;
  /** The same content was already there: nothing was sent. */
  reused: boolean;
  material: SpaceMaterialSnapshot | null;
}

/**
 * One file into an R2 space: hash every part (MD5, streamed through `file.slice`), derive the
 * content id, admit, then PUT the parts straight to R2 — four at a time, each signed URL bound
 * to its part's `Content-MD5` — and complete with the ETags R2 returned.
 *
 * M1 baseline: it runs in the page and remembers nothing across a reload. T045 replaces it with
 * a Web Worker and an IndexedDB journal that resumes an interrupted upload.
 */
export async function uploadFileToSpace(input: SpaceUploadInput): Promise<SpaceUploadResult> {
  const { teamId, source, signal } = input;
  const total = source.size;
  if (!Number.isSafeInteger(total) || total < 0) throw new TeamApiError('INVALID_INPUT', false);
  if (total > SPACE_STORAGE_LIMITS.maxObjectBytes)
    throw new TeamApiError('STORAGE_OBJECT_TOO_LARGE', false);
  if (signal?.aborted) throw canceled(signal);

  const count = spacePartCount(total);
  const md5s: string[] = [];
  for (let part = 1; part <= count; part += 1)
    md5s.push(await partMd5(source, spacePartRange(total, part), signal));
  const identity = await spaceContentId(total, md5s);
  if (!identity.ok) throw new TeamApiError('INVALID_INPUT', false);

  const admitted = await spaceStorageApi.admitUpload(
    {
      teamId,
      parentMaterialId: input.parentMaterialId,
      name: input.name,
      contentType: input.contentType,
      bytes: total,
      contentId: identity.contentId,
      ingress: input.ingress ?? 'explorer',
      idempotencyKey: input.idempotencyKey
    },
    signal
  );
  if (admitted.kind === 'exists') {
    input.onProgress?.(total, total);
    return { materialId: admitted.materialId, reused: true, material: null };
  }
  const uploadId = admitted.uploadId;
  if (admitted.partCount !== count || admitted.partBytes !== spacePartBytes(total)) {
    await spaceStorageApi.abortUpload(teamId, uploadId).catch(() => undefined);
    throw new TeamApiError('INVALID_RESPONSE', false);
  }

  let completing = false;
  try {
    const etags = new Array<string>(count);
    let sent = 0;
    input.onProgress?.(0, total);
    for (let first = 1; first <= count; first += SPACE_STORAGE_LIMITS.partUrlBatch) {
      const last = Math.min(count, first + SPACE_STORAGE_LIMITS.partUrlBatch - 1);
      const numbers = Array.from({ length: last - first + 1 }, (_, index) => first + index);
      const signed = new Map(
        (
          await spaceStorageApi.partUrls(
            teamId,
            uploadId,
            numbers.map(partNumber => ({ partNumber, md5: md5s[partNumber - 1]! })),
            signal
          )
        ).map(part => [part.partNumber, part])
      );
      const queue = [...numbers];
      const worker = async () => {
        for (let partNumber = queue.shift(); partNumber !== undefined; partNumber = queue.shift()) {
          const md5 = md5s[partNumber - 1]!;
          const range = spacePartRange(total, partNumber);
          const resign = async () => {
            const [again] = await spaceStorageApi.partUrls(
              teamId,
              uploadId,
              [{ partNumber, md5 }],
              signal
            );
            if (!again || again.partNumber !== partNumber)
              throw new TeamApiError('INVALID_RESPONSE', false);
            signed.set(partNumber, again);
            return again;
          };
          let url = signed.get(partNumber) ?? (await resign());
          if (Date.parse(url.expiresAt) - PART_URL_MARGIN_MS < Date.now()) url = await resign();
          const etag = await putPart({
            url: url.url,
            md5,
            body: await readRange(source, range.start, range.end + 1, signal),
            signal,
            resign: async () => (await resign()).url
          });
          etags[partNumber - 1] = etag;
          sent += range.bytes;
          input.onProgress?.(sent, total);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_PARALLEL_PARTS, numbers.length) }, worker)
      );
    }
    if (signal?.aborted) throw canceled(signal);
    completing = true;
    const material = await completeWithRetry(
      teamId,
      uploadId,
      etags.map((etag, index) => ({ partNumber: index + 1, etag }))
    );
    rememberSpaceMaterials(teamId, [material]);
    return { materialId: material.id, reused: false, material };
  } catch (failure) {
    // A complete whose answer was lost may have committed; the session expires on its own.
    const uncertain =
      completing &&
      failure instanceof TeamApiError &&
      failure.code === 'TEAM_TRANSPORT_UNAVAILABLE';
    if (!uncertain) await spaceStorageApi.abortUpload(teamId, uploadId).catch(() => undefined);
    throw signal?.aborted ? canceled(signal) : failure;
  }
}

/** One part to its signed URL; a URL R2 refused (400/403: expired, or signed wrong) is re-signed once. */
async function putPart(input: {
  url: string;
  md5: string;
  body: Blob;
  signal?: AbortSignal;
  resign: () => Promise<string>;
}): Promise<string> {
  const contentMd5 = spaceMd5HexToBase64(input.md5);
  if (!contentMd5) throw new TeamApiError('INVALID_INPUT', false);
  let url = input.url;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-MD5': contentMd5 },
        body: input.body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch {
      if (input.signal?.aborted) throw canceled(input.signal);
      throw new TeamApiError('STORAGE_UNAVAILABLE', true);
    }
    if (response.ok) {
      const reported = response.headers.get('ETag');
      // R2 checked the bytes against Content-MD5, so its ETag is that MD5. A missing header
      // (not exposed to the page) is read as that; a different one is not trusted.
      const etag = reported === null ? input.md5 : normalizePartEtag(reported);
      if (etag !== input.md5) throw new TeamApiError('CHECKSUM_MISMATCH', false);
      return etag;
    }
    if ((response.status === 400 || response.status === 403) && attempt === 0) {
      url = await input.resign();
      continue;
    }
    throw new TeamApiError('STORAGE_UNAVAILABLE', response.status >= 500);
  }
}

/** Complete is idempotent on the server, so a lost answer is asked again, a few times. */
async function completeWithRetry(
  teamId: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[]
): Promise<SpaceMaterialSnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await spaceStorageApi.completeUpload(teamId, uploadId, parts);
    } catch (failure) {
      const retry =
        failure instanceof TeamApiError &&
        (failure.code === 'TEAM_TRANSPORT_UNAVAILABLE' || failure.code === 'STORAGE_UNAVAILABLE');
      if (!retry || attempt >= 3) throw failure;
    }
  }
}
