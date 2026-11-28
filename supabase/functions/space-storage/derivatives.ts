/**
 * Derivatives of an R2 space (057 T047, research R5, FR-038 refinement): no server rendering.
 *
 * - `/uploads/{id}/derivatives` — the uploading browser declares what it made of its own file
 *   (the variants the admit's `derivativeSlots` asked for, each with its MD5) and gets one signed
 *   PUT per variant, to a staging key the files host never serves.
 * - At complete (`uploads.ts`), `settleStagedDerivatives` checks every staged derivative: its
 *   size, its type by magic bytes and its pixel size from the header, against the declaration
 *   and the variant's published bounds. Accepted ones are copied to their content key; the
 *   commit learns which. A refused one only costs the file its picture until an agent makes it.
 * - `/derivatives/claim` — a member's page hands an open backfill job to its own agent: a lease
 *   token (only its hash is stored) and a `download_range` ticket for the source.
 * - `/agent/derivatives/stage` and `/agent/derivatives/finish` — the agent, with that lease
 *   only: signed PUTs for what it made, then its outcome, checked the same way.
 *
 * Nothing here reads a derivative whole: the first `sniffBytes` are enough for the header.
 */
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import {
  checkSpaceDerivative,
  isSpaceDerivativeDeclaration,
  isSpaceUuid,
  parseSpaceMediaFacts,
  SPACE_DERIVATIVE_JOB_LIMITS,
  SPACE_DERIVATIVE_RECIPE_VERSION,
  spaceDerivativeKey,
  spaceDerivativeSlotsFor,
  spaceStagingDerivativeKey,
  type SpaceDerivativeDeclaration,
  type SpaceDerivativeType,
  type SpaceDerivativeUrl,
  type SpaceDerivativeVariant,
  type SpaceMediaFacts
} from '../../../packages/shared/dist/team/space-storage.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceStorageJournalEntry } from '../_shared/space-storage-journal.ts';
import { isRecord } from '../_shared/validation.ts';
import { requireSpaceRequest, spaceRpcError, type Rpc } from './handler.ts';
import { issueAgentDownloadGrant } from './process.ts';

/** The part of `SpaceR2` derivatives use; tests hand in a fake. */
export interface SpaceDerivativeBucket {
  signPut(
    key: string,
    md5Hex: string
  ): Promise<{ url: string; contentMd5: string; expiresAt: string }>;
  head(
    key: string,
    signal: AbortSignal
  ): Promise<{ bytes: number; etag: string; contentType: string | null } | null>;
  rangeGet(key: string, start: number, end: number, signal: AbortSignal): Promise<Uint8Array>;
  copy(source: string, target: string, contentType: string, signal: AbortSignal): Promise<void>;
  remove(key: string, signal: AbortSignal): Promise<void>;
}

export interface DerivativeDeps {
  /** The signed-in member; null on the agent's lease routes. */
  actorId: string | null;
  rpc: Rpc;
  bucket: SpaceDerivativeBucket;
  journal: (entry: SpaceStorageJournalEntry) => Promise<unknown>;
  operationId: string;
  client: SpaceStorageJournalEntry['client'];
  signal?: AbortSignal;
  /** A fresh lease token; injectable so tests see which value went where. */
  token?: () => string;
}

const refuse = (code: ConstructorParameters<typeof TeamFunctionError>[0]): never => {
  throw new TeamFunctionError(code, { retryable: false });
};

async function call(rpc: Rpc, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await rpc(name, args);
  } catch (cause) {
    if (cause instanceof TeamFunctionError) throw cause;
    throw spaceRpcError(cause as { message?: unknown; code?: unknown });
  }
}

const signalOf = (deps: { signal?: AbortSignal }) => deps.signal ?? new AbortController().signal;

function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export async function leaseHash(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  );
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function journalOf(deps: DerivativeDeps) {
  return (outcome: SpaceStorageJournalEntry['outcome'], code: string | null, teamId: string) =>
    deps
      .journal({
        operationId: deps.operationId,
        attempt: 1,
        stage: 'derivative',
        outcome,
        code,
        bytes: null,
        teamId,
        ingress: null,
        client: deps.client
      })
      .catch(() => undefined);
}

async function recorded<T>(deps: DerivativeDeps, teamId: string, work: () => Promise<T>) {
  const record = journalOf(deps);
  try {
    const value = await work();
    await record('ok', null, teamId);
    return value;
  } catch (cause) {
    const error =
      cause instanceof TeamFunctionError ? cause : new TeamFunctionError('STORAGE_UNAVAILABLE');
    await record(error.retryable ? 'failed' : 'rejected', error.code, teamId);
    throw error;
  }
}

function parseDeclarations(value: unknown, slots: readonly SpaceDerivativeVariant[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > slots.length) return refuse('INVALID_INPUT');
  const seen = new Set<string>();
  const out: SpaceDerivativeDeclaration[] = [];
  for (const item of value) {
    if (
      !isSpaceDerivativeDeclaration(item) ||
      !slots.includes(item.variant) ||
      seen.has(item.variant)
    )
      return refuse('INVALID_INPUT');
    seen.add(item.variant);
    out.push({
      variant: item.variant,
      contentType: item.contentType,
      bytes: item.bytes,
      width: item.width,
      height: item.height,
      md5: item.md5
    });
  }
  return out;
}

async function signStaged(
  bucket: SpaceDerivativeBucket,
  staged: ReadonlyArray<{
    variant: SpaceDerivativeVariant;
    stagingKey: string;
    md5: string;
    contentType: SpaceDerivativeType;
  }>
): Promise<SpaceDerivativeUrl[]> {
  const out: SpaceDerivativeUrl[] = [];
  for (const item of staged) {
    const signed = await bucket.signPut(item.stagingKey, item.md5);
    out.push({
      variant: item.variant,
      url: signed.url,
      contentMd5: signed.contentMd5,
      contentType: item.contentType,
      expiresAt: signed.expiresAt
    });
  }
  return out;
}

// The check --------------------------------------------------------------------------------

export interface StagedDerivative {
  variant: SpaceDerivativeVariant;
  contentType: SpaceDerivativeType;
  bytes: number;
  width: number;
  height: number;
  stagingKey: string;
}

export type CheckedDerivative = Omit<StagedDerivative, 'stagingKey'> & {
  accepted: boolean;
  reason?: 'type' | 'size' | 'dimensions' | 'missing';
};

/**
 * Checks each staged derivative and moves the accepted ones to their content key. A staging key
 * already gone with the content key holding the declared size is an earlier attempt of the same
 * check that got this far (a retried complete): it counts as accepted. Staging copies are
 * removed best-effort; the lifecycle rule on `u/` takes what is left.
 */
export async function settleStagedDerivatives(
  input: { teamId: string; contentId: string; staged: readonly StagedDerivative[] },
  bucket: SpaceDerivativeBucket,
  signal: AbortSignal
): Promise<CheckedDerivative[]> {
  const out: CheckedDerivative[] = [];
  for (const item of input.staged) {
    const target = spaceDerivativeKey(
      input.teamId,
      input.contentId,
      SPACE_DERIVATIVE_RECIPE_VERSION,
      item.variant
    );
    const { stagingKey, ...declared } = item;
    const head = await bucket.head(stagingKey, signal);
    if (!head) {
      const done = await bucket.head(target, signal);
      out.push(
        done && done.bytes === item.bytes
          ? { ...declared, accepted: true }
          : { ...declared, accepted: false, reason: 'missing' }
      );
      continue;
    }
    const first =
      head.bytes > 0
        ? await bucket.rangeGet(
            stagingKey,
            0,
            Math.min(head.bytes, SPACE_DERIVATIVE_JOB_LIMITS.sniffBytes) - 1,
            signal
          )
        : new Uint8Array(0);
    const verdict = checkSpaceDerivative(declared, { bytes: head.bytes, head: first });
    if (verdict.ok) {
      await bucket.copy(stagingKey, target, item.contentType, signal);
      out.push({ ...declared, accepted: true });
    } else {
      out.push({ ...declared, accepted: false, reason: verdict.reason });
    }
    await bucket.remove(stagingKey, signal).catch(() => undefined);
  }
  return out;
}

/** The declared rows of an upload session, as `service_space_upload_session` returns them. */
export function parseStagedDerivatives(value: unknown): StagedDerivative[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) return refuse('INVALID_RESPONSE');
  return value.map(item => {
    if (
      !isRecord(item) ||
      !isSpaceDerivativeDeclaration({ ...item, md5: item.md5 }) ||
      typeof item.stagingKey !== 'string'
    )
      return refuse('INVALID_RESPONSE');
    return {
      variant: item.variant as SpaceDerivativeVariant,
      contentType: item.contentType as SpaceDerivativeType,
      bytes: item.bytes as number,
      width: item.width as number,
      height: item.height as number,
      stagingKey: item.stagingKey
    };
  });
}

// /uploads/{id}/derivatives -------------------------------------------------------------------

export interface DeclareCommand {
  teamId: string;
  derivatives: unknown;
  media: SpaceMediaFacts;
  unsupported: boolean;
}

export function parseDeclareCommand(body: unknown): DeclareCommand {
  if (!isRecord(body) || !isSpaceUuid(body.teamId)) return refuse('INVALID_INPUT');
  const media = parseSpaceMediaFacts(body.media);
  if (!media.ok || (body.unsupported !== undefined && typeof body.unsupported !== 'boolean'))
    return refuse('INVALID_INPUT');
  return {
    teamId: body.teamId,
    derivatives: body.derivatives,
    media: media.value,
    unsupported: body.unsupported === true
  };
}

/**
 * The browser's derivatives for one open upload. The category comes from the server's own
 * classifier over the session's name and type, never from the client.
 */
export async function declareUploadDerivatives(
  uploadId: string,
  command: DeclareCommand,
  session: { name: string; contentType: string; category: string | null },
  deps: DerivativeDeps & { actorId: string }
): Promise<{ derivatives: SpaceDerivativeUrl[] }> {
  return recorded(deps, command.teamId, async () => {
    const declarations = parseDeclarations(
      command.derivatives,
      spaceDerivativeSlotsFor(session.category)
    );
    const value = await call(deps.rpc, 'service_declare_space_upload_derivatives', {
      p_upload: uploadId,
      p_team: command.teamId,
      p_actor: deps.actorId,
      p_input: {
        category: session.category,
        derivatives: declarations,
        media: {
          durationMs: command.media.durationMs,
          width: command.media.width,
          height: command.media.height
        },
        unsupported: command.unsupported
      }
    });
    if (!Array.isArray(value)) return refuse('INVALID_RESPONSE');
    const staged = value.map(item => {
      const declared = declarations.find(one => isRecord(item) && one.variant === item.variant);
      if (!declared || !isRecord(item) || typeof item.stagingKey !== 'string')
        return refuse('INVALID_RESPONSE');
      if (item.stagingKey !== spaceStagingDerivativeKey(command.teamId, uploadId, declared.variant))
        return refuse('INVALID_RESPONSE');
      return { ...declared, stagingKey: item.stagingKey };
    });
    return { derivatives: await signStaged(deps.bucket, staged) };
  });
}

// /derivatives/claim (a member's page, for its own agent) -------------------------------------

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
  /** Variants already in: the agent makes only the others. */
  made: SpaceDerivativeVariant[];
  needsMediaFacts: boolean;
  leaseToken: string;
  leaseUntil: string;
  /** For `/agent/source`. */
  source: Awaited<ReturnType<typeof issueAgentDownloadGrant>>['grant'];
}

export async function claimDerivativeJob(
  body: unknown,
  deps: DerivativeDeps & { actorId: string }
): Promise<{ job: SpaceDerivativeJob | null }> {
  if (
    !isRecord(body) ||
    !isSpaceUuid(body.teamId) ||
    (body.deviceId !== undefined && !isSpaceUuid(body.deviceId))
  )
    return refuse('INVALID_INPUT');
  const teamId = body.teamId;
  return recorded(deps, teamId, async () => {
    await requireSpaceRequest(deps.rpc, { teamId, actorId: deps.actorId, permission: 'download' });
    const token = (deps.token ?? randomToken)();
    const value = await call(deps.rpc, 'service_claim_space_derivative_jobs', {
      p_team: teamId,
      p_actor: deps.actorId,
      p_lease_hash: await leaseHash(token),
      p_device: (body.deviceId as string | undefined) ?? null,
      p_limit: 1
    });
    if (!isRecord(value) || !Array.isArray(value.jobs)) return refuse('INVALID_RESPONSE');
    const row = value.jobs[0];
    if (row === undefined) return { job: null };
    if (
      !isRecord(row) ||
      !isSpaceUuid(row.objectId) ||
      !isSpaceUuid(row.materialId) ||
      typeof row.name !== 'string' ||
      typeof row.contentId !== 'string' ||
      typeof row.contentType !== 'string' ||
      typeof row.bytes !== 'string' ||
      typeof row.leaseUntil !== 'string' ||
      !Array.isArray(row.made) ||
      (row.reason !== 'browser_unsupported' &&
        row.reason !== 'missing_media_facts' &&
        row.reason !== 'client_skipped')
    )
      return refuse('INVALID_RESPONSE');
    const source = await issueAgentDownloadGrant(
      { teamId, materialId: row.materialId },
      {
        actorId: deps.actorId,
        rpc: deps.rpc,
        bucket: null,
        readGrant: null,
        journal: deps.journal,
        operationId: deps.operationId,
        client: deps.client
      }
    );
    return {
      job: {
        teamId,
        objectId: row.objectId,
        recipeVersion: SPACE_DERIVATIVE_RECIPE_VERSION,
        reason: row.reason,
        materialId: row.materialId,
        name: row.name,
        category: typeof row.category === 'string' ? row.category : null,
        contentId: row.contentId,
        contentType: row.contentType,
        bytes: row.bytes,
        made: row.made.filter(
          (item): item is SpaceDerivativeVariant => typeof item === 'string'
        ) as SpaceDerivativeVariant[],
        needsMediaFacts: row.needsMediaFacts === true,
        leaseToken: token,
        leaseUntil: row.leaseUntil,
        source: source.grant
      }
    };
  });
}

// /agent/derivatives/* (the lease is the authority) --------------------------------------------

interface Lease {
  teamId: string;
  objectId: string;
  claimId: string;
  contentId: string;
  slots: SpaceDerivativeVariant[];
  hash: string;
}

async function readLease(body: unknown, deps: DerivativeDeps): Promise<Lease> {
  if (
    !isRecord(body) ||
    !isSpaceUuid(body.teamId) ||
    !isSpaceUuid(body.objectId) ||
    typeof body.leaseToken !== 'string' ||
    !LEASE_TOKEN.test(body.leaseToken)
  )
    return refuse('INVALID_INPUT');
  const hash = await leaseHash(body.leaseToken);
  const value = await call(deps.rpc, 'service_space_derivative_lease', {
    p_team: body.teamId,
    p_object: body.objectId,
    p_lease_hash: hash
  });
  if (
    !isRecord(value) ||
    value.objectId !== body.objectId ||
    !isSpaceUuid(value.claimId) ||
    typeof value.contentId !== 'string' ||
    !Array.isArray(value.slots)
  )
    return refuse('INVALID_RESPONSE');
  return {
    teamId: body.teamId,
    objectId: body.objectId,
    claimId: value.claimId,
    contentId: value.contentId,
    slots: value.slots.filter(
      (item): item is SpaceDerivativeVariant => typeof item === 'string'
    ) as SpaceDerivativeVariant[],
    hash
  };
}

export async function stageAgentDerivatives(
  body: unknown,
  deps: DerivativeDeps
): Promise<{ derivatives: SpaceDerivativeUrl[] }> {
  const lease = await readLease(body, deps);
  return recorded(deps, lease.teamId, async () => {
    const declarations = parseDeclarations(
      (body as Record<string, unknown>).derivatives,
      lease.slots
    );
    return {
      derivatives: await signStaged(
        deps.bucket,
        declarations.map(item => ({
          ...item,
          stagingKey: spaceStagingDerivativeKey(lease.teamId, lease.claimId, item.variant)
        }))
      )
    };
  });
}

export async function finishAgentDerivative(
  body: unknown,
  deps: DerivativeDeps
): Promise<{ state: string; accepted: SpaceDerivativeVariant[] }> {
  const lease = await readLease(body, deps);
  return recorded(deps, lease.teamId, async () => {
    const record = body as Record<string, unknown>;
    const outcome = record.outcome;
    if (outcome !== 'ready' && outcome !== 'unsupported' && outcome !== 'failed')
      return refuse('INVALID_INPUT');
    const media = parseSpaceMediaFacts(record.media);
    const errorCode =
      typeof record.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(record.errorCode)
        ? record.errorCode
        : null;
    if (!media.ok || (record.errorCode !== undefined && record.errorCode !== null && !errorCode))
      return refuse('INVALID_INPUT');
    let accepted: CheckedDerivative[] = [];
    let finalOutcome: 'ready' | 'unsupported' | 'failed' = outcome;
    if (outcome === 'ready') {
      const declarations = parseDeclarations(record.derivatives, lease.slots);
      const checked = await settleStagedDerivatives(
        {
          teamId: lease.teamId,
          contentId: lease.contentId,
          staged: declarations.map(item => ({
            variant: item.variant,
            contentType: item.contentType,
            bytes: item.bytes,
            width: item.width,
            height: item.height,
            stagingKey: spaceStagingDerivativeKey(lease.teamId, lease.claimId, item.variant)
          }))
        },
        deps.bucket,
        signalOf(deps)
      );
      accepted = checked.filter(item => item.accepted);
      // Facts alone are a result (a video whose pictures the browser already made); pictures
      // that were all refused are a failed attempt.
      if (declarations.length > 0 && accepted.length === 0) finalOutcome = 'failed';
    }
    const value = await call(deps.rpc, 'service_finish_space_derivative', {
      p_team: lease.teamId,
      p_object: lease.objectId,
      p_lease_hash: lease.hash,
      p_input: {
        outcome: finalOutcome,
        derivatives: accepted.map(({ accepted: _accepted, reason: _reason, ...item }) => item),
        media: media.value,
        errorCode:
          finalOutcome === 'failed' && outcome === 'ready' ? 'DERIVATIVE_REJECTED' : errorCode
      }
    });
    if (!isRecord(value) || typeof value.state !== 'string') return refuse('INVALID_RESPONSE');
    return { state: value.state, accepted: accepted.map(item => item.variant) };
  });
}
