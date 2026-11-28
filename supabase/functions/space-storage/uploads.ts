/**
 * `/uploads/admit`, `/uploads/{id}/parts`, `/uploads/{id}/complete`, `/uploads/{id}/abort`
 * (057 T023, contracts/storage-api.md, research R3).
 *
 * Bytes never pass through here: the client PUTs each part straight to R2 on a URL signed with
 * the part's `Content-MD5`, so R2 refuses a damaged part. The database owns every decision
 * (`service_*_space_upload`, 20261226150000): reservation, dedup within the space, commit. This
 * module only talks to the bucket and recomputes the content id from what R2 itself reports —
 * the part ETags of `ListParts` — never from what the client sent.
 *
 * The original's multipart targets its final key `t/{team}/o/{content_id}`; nothing is visible
 * there until this module completes it, which it does only after the recomputed id matched.
 */
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import {
  formatByteCount,
  isSpaceContentId,
  isSpaceDerivativeType,
  isSpaceDerivativeVariant,
  isSpaceIngress,
  isSpaceKey,
  isSpaceUuid,
  parseByteCount,
  parseSpaceAdmitResult,
  parseSpaceMaterialSnapshot,
  SPACE_DERIVATIVE_VARIANTS,
  SPACE_STORAGE_LIMITS,
  spaceContentId,
  spaceDerivativeSlotsFor,
  spacePartRange,
  type SpaceAdmitResult,
  type SpaceIngress,
  type SpaceMaterialSnapshot,
  type SpacePartUrl
} from '../../../packages/shared/dist/team/space-storage.js';
// @deno-types="../../../packages/shared/dist/team/space-storage-md5.d.ts"
import { spaceMd5Hex } from '../../../packages/shared/dist/team/space-storage-md5.js';
// @deno-types="../../../packages/shared/dist/team/material-category.d.ts"
import { classifyMaterial } from '../../../packages/shared/dist/team/material-category.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceListedPart, SpaceSignedPart } from '../_shared/r2-space.ts';
import type { SpaceStorageJournalEntry } from '../_shared/space-storage-journal.ts';
import { isRecord } from '../_shared/validation.ts';
import { requireSpaceRequest, spaceRpcError, type Rpc } from './handler.ts';
import {
  declareUploadDerivatives,
  parseStagedDerivatives,
  settleStagedDerivatives,
  type CheckedDerivative,
  type DeclareCommand,
  type SpaceDerivativeBucket,
  type StagedDerivative
} from './derivatives.ts';

/** The part of `SpaceR2` an upload uses; tests hand in a fake. */
export interface SpaceUploadBucket {
  createMultipart(key: string, contentType: string, signal: AbortSignal): Promise<string>;
  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    md5Hex: string
  ): Promise<SpaceSignedPart>;
  listParts(key: string, uploadId: string, signal: AbortSignal): Promise<SpaceListedPart[]>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
    signal: AbortSignal
  ): Promise<{ etag: string }>;
  abortMultipart(key: string, uploadId: string, signal: AbortSignal): Promise<void>;
  head(
    key: string,
    signal: AbortSignal
  ): Promise<{ bytes: number; etag: string; contentType: string | null } | null>;
  /** Derivatives (T047): present on the real bucket; a fake without them stages nothing. */
  signPut?: SpaceDerivativeBucket['signPut'];
  rangeGet?: SpaceDerivativeBucket['rangeGet'];
  copy?: SpaceDerivativeBucket['copy'];
  remove?: SpaceDerivativeBucket['remove'];
}

function derivativeBucket(bucket: SpaceUploadBucket): SpaceDerivativeBucket {
  const { signPut, rangeGet, copy, remove, head } = bucket;
  if (!signPut || !rangeGet || !copy || !remove) throw new TeamFunctionError('STORAGE_UNAVAILABLE');
  return {
    signPut: signPut.bind(bucket),
    rangeGet: rangeGet.bind(bucket),
    copy: copy.bind(bucket),
    remove: remove.bind(bucket),
    head: head.bind(bucket)
  };
}

export interface UploadDeps {
  actorId: string;
  rpc: Rpc;
  bucket: SpaceUploadBucket;
  journal: (entry: SpaceStorageJournalEntry) => Promise<unknown>;
  operationId: string;
  client: SpaceStorageJournalEntry['client'];
  signal?: AbortSignal;
}

const refuse = (code: ConstructorParameters<typeof TeamFunctionError>[0]): never => {
  throw new TeamFunctionError(code, { retryable: false });
};

const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,128}$/u;
const MD5 = /^[0-9a-f]{32}$/u;

// Commands --------------------------------------------------------------------------------

export interface AdmitCommand {
  teamId: string;
  /** Null: the root of the space. */
  parentMaterialId: string | null;
  name: string;
  contentType: string;
  bytes: bigint;
  contentId: string;
  sha256: string | null;
  ingress: SpaceIngress;
  idempotencyKey: string;
}

/**
 * Derivatives declared with the admit are checked for shape only and otherwise ignored: since
 * T047 the client learns the slots from the admit's answer, makes them, and declares them at
 * `/uploads/{id}/derivatives` (an older client that sent them here simply gets an agent job).
 */
function validDerivatives(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > Object.keys(SPACE_DERIVATIVE_VARIANTS).length)
    return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isSpaceDerivativeVariant(item.variant) || seen.has(item.variant))
      return false;
    seen.add(item.variant);
    const limit = SPACE_DERIVATIVE_VARIANTS[item.variant];
    const bytes = parseByteCount(item.bytes);
    if (
      !isSpaceDerivativeType(item.contentType) ||
      bytes === null ||
      bytes < 1n ||
      bytes > BigInt(limit.maxBytes) ||
      !Number.isSafeInteger(item.width) ||
      !Number.isSafeInteger(item.height) ||
      (item.width as number) < 1 ||
      (item.height as number) < 1 ||
      (item.width as number) > limit.maxWidth ||
      (item.height as number) > limit.maxHeight
    )
      return false;
  }
  return true;
}

/** A file name the explorer can show: NFC, trimmed, no control characters or slashes. */
export function normalizeSpaceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  if (
    name.length < 1 ||
    name.length > SPACE_STORAGE_LIMITS.maxNameLength ||
    name.includes('/') ||
    [...name].some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
  )
    return null;
  return name;
}

function normalizeContentType(value: unknown): string {
  if (typeof value !== 'string') return 'application/octet-stream';
  const type = value.split(';', 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/u.test(type)
    ? type
    : 'application/octet-stream';
}

export function parseAdmitCommand(body: unknown): AdmitCommand {
  if (!isRecord(body)) return refuse('INVALID_INPUT');
  const name = normalizeSpaceName(body.name);
  const bytes = parseByteCount(body.bytes);
  if (
    !isSpaceUuid(body.teamId) ||
    (body.parentMaterialId !== null && !isSpaceUuid(body.parentMaterialId)) ||
    !name ||
    bytes === null ||
    !isSpaceContentId(body.contentId) ||
    (body.sha256 !== undefined && body.sha256 !== null && !isSpaceContentId(body.sha256)) ||
    !isSpaceIngress(body.ingress) ||
    typeof body.idempotencyKey !== 'string' ||
    !IDEMPOTENCY.test(body.idempotencyKey) ||
    !validDerivatives(body.derivatives)
  )
    return refuse('INVALID_INPUT');
  if (bytes > BigInt(SPACE_STORAGE_LIMITS.maxObjectBytes))
    return refuse('STORAGE_OBJECT_TOO_LARGE');
  return {
    teamId: body.teamId,
    parentMaterialId: body.parentMaterialId as string | null,
    name,
    contentType: normalizeContentType(body.contentType),
    bytes,
    contentId: body.contentId,
    sha256: (body.sha256 as string | null | undefined) ?? null,
    ingress: body.ingress,
    idempotencyKey: body.idempotencyKey
  };
}

export interface PartsCommand {
  teamId: string;
  parts: Array<{ partNumber: number; md5: string }>;
}

export function parsePartsCommand(body: unknown): PartsCommand {
  if (!isRecord(body) || !isSpaceUuid(body.teamId) || !Array.isArray(body.parts))
    return refuse('INVALID_INPUT');
  if (body.parts.length < 1 || body.parts.length > SPACE_STORAGE_LIMITS.partUrlBatch)
    return refuse('INVALID_INPUT');
  const parts: PartsCommand['parts'] = [];
  for (const part of body.parts) {
    if (
      !isRecord(part) ||
      !Number.isSafeInteger(part.partNumber) ||
      (part.partNumber as number) < 1 ||
      (part.partNumber as number) > SPACE_STORAGE_LIMITS.maxParts ||
      typeof part.md5 !== 'string' ||
      !MD5.test(part.md5)
    )
      return refuse('INVALID_INPUT');
    parts.push({ partNumber: part.partNumber as number, md5: part.md5 });
  }
  if (new Set(parts.map(part => part.partNumber)).size !== parts.length)
    return refuse('INVALID_INPUT');
  return { teamId: body.teamId, parts };
}

/** The client's part list is shape-checked only; what counts is what R2 reports. */
export function parseCompleteCommand(body: unknown): { teamId: string } {
  if (!isRecord(body) || !isSpaceUuid(body.teamId)) return refuse('INVALID_INPUT');
  if (body.parts !== undefined) {
    if (!Array.isArray(body.parts) || body.parts.length > SPACE_STORAGE_LIMITS.maxParts)
      return refuse('INVALID_INPUT');
    for (const part of body.parts)
      if (
        !isRecord(part) ||
        !Number.isSafeInteger(part.partNumber) ||
        typeof part.etag !== 'string'
      )
        return refuse('INVALID_INPUT');
  }
  return { teamId: body.teamId };
}

export function parseTeamCommand(body: unknown): { teamId: string } {
  if (!isRecord(body) || !isSpaceUuid(body.teamId)) return refuse('INVALID_INPUT');
  return { teamId: body.teamId };
}

// Sessions as the database returns them ---------------------------------------------------

interface SessionFacts {
  state: 'open' | 'completing' | 'committed';
  uploadId: string;
  partCount: number;
  r2UploadId: string | null;
  objectKey: string;
  declaredContentId: string;
  declaredBytes: bigint;
  name: string;
  contentType: string;
  /** Derivatives declared for this upload and not yet checked (T047). */
  derivatives: StagedDerivative[];
}

type SessionAnswer =
  | { kind: 'session'; facts: SessionFacts; public: SpaceAdmitResult }
  | { kind: 'exists'; public: SpaceAdmitResult }
  | { kind: 'expired' }
  | { kind: 'rejected'; code: string }
  | { kind: 'quota'; needBytes: string; freeBytes: string };

function parseSession(value: unknown): SessionAnswer {
  if (!isRecord(value)) return refuse('INVALID_RESPONSE');
  if (value.kind === 'expired') return { kind: 'expired' };
  if (value.kind === 'rejected')
    return {
      kind: 'rejected',
      code: typeof value.code === 'string' ? value.code : 'INVALID_INPUT'
    };
  if (value.kind === 'quota') {
    const need = parseByteCount(value.needBytes);
    const free = parseByteCount(value.freeBytes);
    if (need === null || free === null) return refuse('INVALID_RESPONSE');
    return { kind: 'quota', needBytes: formatByteCount(need), freeBytes: formatByteCount(free) };
  }
  const parsed = parseSpaceAdmitResult(value);
  if (!parsed.ok) return refuse('INVALID_RESPONSE');
  if (parsed.value.kind === 'exists') return { kind: 'exists', public: parsed.value };
  const declaredBytes = parseByteCount(value.declaredBytes);
  if (
    (value.state !== 'open' && value.state !== 'completing' && value.state !== 'committed') ||
    (value.r2UploadId !== null &&
      (typeof value.r2UploadId !== 'string' || value.r2UploadId.length > 1024)) ||
    !isSpaceKey(value.objectKey) ||
    !isSpaceContentId(value.declaredContentId) ||
    declaredBytes === null ||
    typeof value.name !== 'string' ||
    typeof value.contentType !== 'string'
  )
    return refuse('INVALID_RESPONSE');
  return {
    kind: 'session',
    public: parsed.value,
    facts: {
      state: value.state,
      uploadId: parsed.value.uploadId,
      partCount: parsed.value.partCount,
      r2UploadId: value.r2UploadId as string | null,
      objectKey: value.objectKey,
      declaredContentId: value.declaredContentId,
      declaredBytes,
      name: value.name,
      contentType: value.contentType,
      derivatives: parseStagedDerivatives(value.derivatives)
    }
  };
}

function quotaExceeded(needBytes: string, freeBytes: string): never {
  throw new TeamFunctionError('STORAGE_QUOTA_EXCEEDED', {
    retryable: false,
    details: { needBytes, freeBytes }
  });
}

/** Database refusals arrive as thrown errors; map anything that is not ours yet. */
async function call(rpc: Rpc, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await rpc(name, args);
  } catch (cause) {
    if (cause instanceof TeamFunctionError) throw cause;
    throw spaceRpcError(cause as { message?: unknown; code?: unknown });
  }
}

function journalOf(deps: UploadDeps, stage: SpaceStorageJournalEntry['stage']) {
  return (
    outcome: SpaceStorageJournalEntry['outcome'],
    code: string | null,
    teamId: string,
    bytes: bigint | null,
    ingress: SpaceIngress | null = null
  ) =>
    deps
      .journal({
        operationId: deps.operationId,
        attempt: 1,
        stage,
        outcome,
        code,
        bytes,
        teamId,
        ingress,
        client: deps.client
      })
      .catch(() => undefined);
}

async function recorded<T>(
  record: ReturnType<typeof journalOf>,
  teamId: string,
  bytes: bigint | null,
  work: () => Promise<T>,
  ingress: SpaceIngress | null = null
): Promise<T> {
  try {
    const value = await work();
    await record('ok', null, teamId, bytes, ingress);
    return value;
  } catch (cause) {
    const error =
      cause instanceof TeamFunctionError ? cause : new TeamFunctionError('STORAGE_UNAVAILABLE');
    await record(error.retryable ? 'failed' : 'rejected', error.code, teamId, bytes, ingress);
    throw error;
  }
}

const signalOf = (deps: UploadDeps) => deps.signal ?? new AbortController().signal;

// Admit -----------------------------------------------------------------------------------

export async function admitUpload(
  command: AdmitCommand,
  deps: UploadDeps
): Promise<SpaceAdmitResult> {
  const record = journalOf(deps, 'admit');
  return recorded(
    record,
    command.teamId,
    command.bytes,
    async () => {
      await requireSpaceRequest(deps.rpc, {
        teamId: command.teamId,
        actorId: deps.actorId,
        permission: 'upload'
      });
      const answer = parseSession(
        await call(deps.rpc, 'service_admit_space_upload', {
          p_actor: deps.actorId,
          p_input: {
            teamId: command.teamId,
            parentMaterialId: command.parentMaterialId,
            name: command.name,
            contentType: command.contentType,
            bytes: formatByteCount(command.bytes),
            contentId: command.contentId,
            sha256: command.sha256,
            ingress: command.ingress,
            idempotencyKey: command.idempotencyKey,
            ...classificationOf(command.name, command.contentType)
          }
        })
      );
      if (answer.kind === 'quota') return quotaExceeded(answer.needBytes, answer.freeBytes);
      if (answer.kind === 'exists') return answer.public;
      if (answer.kind !== 'session') return refuse('UPLOAD_EXPIRED');
      if (answer.facts.r2UploadId === null && answer.facts.state === 'open') {
        await openMultipart(answer.facts, command.contentType, deps);
      }
      // What the client should make of its own file while the parts go (T047): a session for
      // new content has no derivatives yet, so the slots follow from the category alone.
      return answer.public.kind === 'session' && answer.facts.state === 'open'
        ? {
            ...answer.public,
            derivativeSlots: spaceDerivativeSlotsFor(
              classificationOf(command.name, command.contentType).category
            )
          }
        : answer.public;
    },
    command.ingress
  );
}

/** Open the multipart for a session that has none yet; a racing second one is aborted. */
async function openMultipart(facts: SessionFacts, contentType: string, deps: UploadDeps) {
  const signal = signalOf(deps);
  const opened = await deps.bucket.createMultipart(facts.objectKey, contentType, signal);
  const attached = parseSession(
    await call(deps.rpc, 'service_attach_space_upload', {
      p_upload: facts.uploadId,
      p_actor: deps.actorId,
      p_r2_upload_id: opened
    })
  );
  if (attached.kind !== 'session' || attached.facts.r2UploadId !== opened)
    await deps.bucket.abortMultipart(facts.objectKey, opened, signal).catch(() => undefined);
}

/** The session of an upload for its uploader, or the closed reason it has none. */
async function loadSession(
  uploadId: string,
  teamId: string,
  deps: UploadDeps
): Promise<SessionFacts> {
  await requireSpaceRequest(deps.rpc, { teamId, actorId: deps.actorId, permission: 'upload' });
  const answer = parseSession(
    await call(deps.rpc, 'service_space_upload_session', {
      p_upload: uploadId,
      p_team: teamId,
      p_actor: deps.actorId
    })
  );
  if (answer.kind === 'expired') return refuse('UPLOAD_EXPIRED');
  if (answer.kind === 'rejected')
    return refuse(answer.code === 'CHECKSUM_MISMATCH' ? 'CHECKSUM_MISMATCH' : 'UPLOAD_EXPIRED');
  if (answer.kind !== 'session' || answer.facts.uploadId !== uploadId)
    return refuse('INVALID_RESPONSE');
  return answer.facts;
}

// Parts -----------------------------------------------------------------------------------

export async function signUploadParts(
  uploadId: string,
  command: PartsCommand,
  deps: UploadDeps
): Promise<{ parts: SpacePartUrl[] }> {
  const record = journalOf(deps, 'parts');
  return recorded(record, command.teamId, null, async () => {
    const facts = await loadSession(uploadId, command.teamId, deps);
    if (facts.state !== 'open' || facts.r2UploadId === null) return refuse('WRONG_STATE');
    if (command.parts.some(part => part.partNumber > facts.partCount))
      return refuse('INVALID_INPUT');
    const parts: SpacePartUrl[] = [];
    for (const part of command.parts) {
      const signed = await deps.bucket.signPart(
        facts.objectKey,
        facts.r2UploadId,
        part.partNumber,
        part.md5
      );
      parts.push({ partNumber: signed.partNumber, url: signed.url, expiresAt: signed.expiresAt });
    }
    return { parts };
  });
}

// Derivatives (T047) -----------------------------------------------------------------------

export async function declareDerivatives(
  uploadId: string,
  command: DeclareCommand,
  deps: UploadDeps
): Promise<Awaited<ReturnType<typeof declareUploadDerivatives>>> {
  const facts = await loadSession(uploadId, command.teamId, deps);
  if (facts.state !== 'open') return refuse('WRONG_STATE');
  return declareUploadDerivatives(
    uploadId,
    command,
    {
      name: facts.name,
      contentType: facts.contentType,
      category: classificationOf(facts.name, facts.contentType).category
    },
    { ...deps, bucket: derivativeBucket(deps.bucket) }
  );
}

// Complete --------------------------------------------------------------------------------

const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, n) =>
    Number.parseInt(hex.slice(n * 2, n * 2 + 2), 16)
  );

/** The ETag S3 and R2 give a multipart object: MD5 over the parts' binary MD5s, then `-N`. */
export function multipartObjectEtag(partEtags: readonly string[]): string {
  const joined = new Uint8Array(partEtags.length * 16);
  partEtags.forEach((etag, index) => joined.set(hexBytes(etag), index * 16));
  return `${spaceMd5Hex(joined)}-${partEtags.length}`;
}

/**
 * Verify what R2 holds for the session: every part present, in order, of the canonical size,
 * adding up to the declared length, and the content id recomputed from R2's own part ETags equal to the declared one.
 */
export async function verifyListedParts(
  facts: Pick<SessionFacts, 'partCount' | 'declaredBytes' | 'declaredContentId'>,
  listed: readonly SpaceListedPart[]
): Promise<{ ok: true; objectEtag: string; parts: SpaceListedPart[] } | { ok: false }> {
  if (listed.length !== facts.partCount) return { ok: false };
  if (listed.some((part, index) => part.partNumber !== index + 1)) return { ok: false };
  const total = listed.reduce((sum, part) => sum + BigInt(part.bytes), 0n);
  if (total !== facts.declaredBytes || total > BigInt(Number.MAX_SAFE_INTEGER))
    return { ok: false };
  // Every part must have the size the declared length implies. R2 itself refuses parts of
  // unequal size at completion (`400 InvalidPart`, qualification 2026-11-28), and the content id
  // is only canonical for the canonical split, so a different split is refused here, before
  // the session is marked completing.
  if (listed.some((part, index) => part.bytes !== spacePartRange(Number(total), index + 1).bytes))
    return { ok: false };
  const recomputed = await spaceContentId(
    Number(total),
    listed.map(part => part.etag)
  );
  if (!recomputed.ok || recomputed.contentId !== facts.declaredContentId) return { ok: false };
  return {
    ok: true,
    objectEtag: multipartObjectEtag(listed.map(part => part.etag)),
    parts: [...listed]
  };
}

function classificationOf(name: string, contentType: string) {
  const extension = /\.([^./]{1,32})$/u.exec(name)?.[1] ?? null;
  const classification = classifyMaterial({
    kind: 'file',
    mimeType: contentType,
    fileExtension: extension
  });
  return {
    category: classification.category,
    classificationSource:
      classification.source === 'inspected_landing' ? 'fallback' : classification.source,
    fileExtension: classification.normalizedExtension
  };
}

export async function completeUpload(
  uploadId: string,
  command: { teamId: string },
  deps: UploadDeps
): Promise<SpaceMaterialSnapshot> {
  const record = journalOf(deps, 'complete');
  return recorded(record, command.teamId, null, async () => {
    const facts = await loadSession(uploadId, command.teamId, deps);
    const commit = async () => {
      // The derivatives are checked once the original is in place, just before the commit that
      // records them; a commit that already happened has nothing left to check.
      let derivatives: CheckedDerivative[] = [];
      if (facts.state !== 'committed' && facts.derivatives.length > 0)
        derivatives = await settleStagedDerivatives(
          {
            teamId: command.teamId,
            contentId: facts.declaredContentId,
            staged: facts.derivatives
          },
          derivativeBucket(deps.bucket),
          signalOf(deps)
        );
      const value = await call(deps.rpc, 'service_complete_space_upload', {
        p_upload: uploadId,
        p_team: command.teamId,
        p_actor: deps.actorId,
        p_input: {
          ...classificationOf(facts.name, facts.contentType),
          ...(derivatives.length > 0 ? { derivatives } : {})
        }
      });
      const parsed = parseSpaceMaterialSnapshot(value);
      if (!parsed.ok) return refuse('INVALID_RESPONSE');
      return parsed.value;
    };
    if (facts.state === 'committed') return commit();
    if (facts.r2UploadId === null) return refuse('WRONG_STATE');
    const signal = signalOf(deps);

    let listed: SpaceListedPart[] | null;
    try {
      listed = await deps.bucket.listParts(facts.objectKey, facts.r2UploadId, signal);
    } catch (cause) {
      if (!(cause instanceof TeamFunctionError) || cause.code !== 'NOT_FOUND') throw cause;
      listed = null;
    }

    if (listed === null) {
      // The multipart is gone. After a completion whose reply was lost, the object is at its
      // content key with the declared length (the key names the content, so it can only be
      // these bytes); otherwise it was aborted and the session is over.
      if (facts.state !== 'completing') return refuse('UPLOAD_EXPIRED');
      const head = await deps.bucket.head(facts.objectKey, signal);
      if (!head || BigInt(head.bytes) !== facts.declaredBytes) return refuse('UPLOAD_EXPIRED');
      return commit();
    }

    const verified = await verifyListedParts(facts, listed);
    if (!verified.ok) {
      await deps.bucket
        .abortMultipart(facts.objectKey, facts.r2UploadId, signal)
        .catch(() => undefined);
      await call(deps.rpc, 'service_reject_space_upload', {
        p_upload: uploadId,
        p_team: command.teamId,
        p_actor: deps.actorId,
        p_code: 'CHECKSUM_MISMATCH'
      });
      return refuse('CHECKSUM_MISMATCH');
    }
    await call(deps.rpc, 'service_mark_space_upload_completing', {
      p_upload: uploadId,
      p_team: command.teamId,
      p_actor: deps.actorId,
      p_content_id: facts.declaredContentId,
      p_object_etag: verified.objectEtag
    });
    try {
      await deps.bucket.completeMultipart(
        facts.objectKey,
        facts.r2UploadId,
        verified.parts,
        signal
      );
    } catch (cause) {
      // Completed by a racing retry of our own: the object is there.
      if (!(cause instanceof TeamFunctionError) || cause.code !== 'NOT_FOUND') throw cause;
      const head = await deps.bucket.head(facts.objectKey, signal);
      if (!head || BigInt(head.bytes) !== facts.declaredBytes) return refuse('UPLOAD_EXPIRED');
    }
    return commit();
  });
}

// Abort -----------------------------------------------------------------------------------

export async function abortUpload(
  uploadId: string,
  command: { teamId: string },
  deps: UploadDeps
): Promise<{ aborted: true }> {
  const record = journalOf(deps, 'abort');
  return recorded(record, command.teamId, null, async () => {
    let facts: SessionFacts | null = null;
    try {
      facts = await loadSession(uploadId, command.teamId, deps);
    } catch (cause) {
      // An expired or rejected session has nothing left to close here.
      if (!(cause instanceof TeamFunctionError) || cause.code !== 'UPLOAD_EXPIRED') throw cause;
    }
    if (facts?.state === 'committed') return refuse('WRONG_STATE');
    if (facts?.r2UploadId)
      await deps.bucket.abortMultipart(facts.objectKey, facts.r2UploadId, signalOf(deps));
    await call(deps.rpc, 'service_abort_space_upload', {
      p_upload: uploadId,
      p_team: command.teamId,
      p_actor: deps.actorId
    });
    return { aborted: true as const };
  });
}
