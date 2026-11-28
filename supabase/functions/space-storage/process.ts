/**
 * A tool run in an R2 space (057 T033/T035, contracts/storage-api.md): `/process/start`,
 * `/agent/source`, `/process/output/start`, `/process/output/parts`,
 * `/process/output/finalize` and `/process/output/quiesced`.
 *
 * The same run a Drive space has (drive-ops `handleProcessStart`, `handleProcessOutputStart`,
 * `handleProcessOutputFinalize`, `handleProcessOutputQuiesced`), on R2:
 *
 * - start: the web asks for a run; the database opens a `team_operations` row with the output
 *   name reserved by the same pure plan drive-ops uses, and two agent tickets come back — one to
 *   read the source (`process_input`), one for the output (`finalize`). Only hashes of tickets
 *   reach the database.
 * - the agent trades its read ticket at `/agent/source` for a files-host URL with a read grant
 *   (the space-read Worker serves Range); a 401 there means the grant lapsed and it trades again.
 * - the output is an ordinary R2 upload (uploads.ts) admitted with ingress `agent_output` under
 *   the key `process_output_<operation>`, so it is bound to the run, deduplicated within the space
 *   and counted against its capacity like any upload. Protocol 2 — the Drive upload — is told to
 *   update before the ticket is spent.
 * - finalize completes that upload (R2's own part ETags decide, never the agent's word) and then
 *   records it as the run's result in one transaction (20261226190000): `processed_from`, the
 *   operation succeeded, the bytes under `process`. A repeat answers the same material.
 * - quiesced: the agent settled without a result; an open output session is aborted and its
 *   reservation released.
 *
 * Not on R2 yet, refused at start: a new version of the source (versions are refused on R2 for
 * now), catalog variants (their own route, T041) and the retired translation.
 */
// @deno-types="../../../packages/shared/dist/team/contract.d.ts"
import {
  AGENT_INTAKE_MAX_BYTES,
  OPERATION_GRANT_TTL_SECONDS,
  RANGE_REQUEST_MAX_BYTES
} from '../../../packages/shared/dist/team/contract.js';
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import {
  isSpaceContentId,
  isSpaceUuid,
  parseByteCount,
  spaceFilesUrl,
  SPACE_STORAGE_LIMITS
} from '../../../packages/shared/dist/team/space-storage.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceStorageJournalEntry } from '../_shared/space-storage-journal.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  buildUploadConflictPlan,
  displayDriveName,
  PROCESS_TOOL_RULES
} from '../drive-ops/handler.ts';
import { requireSpaceRequest, spaceRpcError, type Rpc } from './handler.ts';
import { readMaterials } from './mutate.ts';
import { issueReadGrant, type SpaceReadGrantConfig } from './read.ts';
import {
  abortUpload,
  admitUpload,
  completeUpload,
  signUploadParts,
  type SpaceUploadBucket
} from './uploads.ts';

/** The workspace contract that first reads and writes R2 (packages/shared release.ts). */
export const SPACE_PROCESS_AGENT_CONTRACT = 3;
/** The output upload protocol of that contract: an R2 multipart instead of a Drive session. */
export const SPACE_OUTPUT_UPLOAD_PROTOCOL = 3;
/**
 * Uses of the output ticket: the start, one per batch of signed parts (≤100 parts each, and
 * again after a resume), up to three finalizes and the quiescence acknowledgement. 10 000
 * parts in 100-part batches is 100; the rest is headroom for re-signing after a lapse.
 */
const OUTPUT_TICKET_USES = 240;
/** Uses of the read ticket: the first files URL and a fresh one each time its grant lapses. */
const SOURCE_TICKET_USES = 64;
const NAME_RESERVATION_MS = 30 * 60 * 1000;

export interface ProcessDeps {
  /** The signed-in member for `/process/start`; null on the agent's ticketed routes. */
  actorId: string | null;
  rpc: Rpc;
  bucket: SpaceUploadBucket | null;
  readGrant: SpaceReadGrantConfig | null;
  journal: (entry: SpaceStorageJournalEntry) => Promise<unknown>;
  operationId: string;
  client: SpaceStorageJournalEntry['client'];
  signal?: AbortSignal;
  /** A fresh agent ticket; injectable so tests can see which value went where. */
  ticket?: () => string;
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

const IDEMPOTENCY = /^[a-z0-9][a-z0-9._:-]{7,199}$/iu;

function randomTicket(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function ticketHash(ticket: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  );
  return `\\x${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function firstRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return isRecord(row) ? row : null;
}

const text = (row: Record<string, unknown>, key: string): string | null =>
  typeof row[key] === 'string' ? (row[key] as string) : null;

// /process/start ----------------------------------------------------------------------------

export interface ProcessStartCommand {
  teamId: string;
  materialId: string;
  destinationFolderId: string | null;
  idempotencyKey: string;
  toolId: string;
  outputName: string;
  conflictMode: 'cancel' | 'keep_both';
  agentContractVersion: number;
  toolContractVersion: number;
}

export function parseProcessStartCommand(body: unknown): ProcessStartCommand {
  if (!isRecord(body)) return refuse('INVALID_INPUT');
  if (body.toolId === 'translation') return refuse('FEATURE_RETIRED');
  const destination = body.destinationFolderId;
  if (
    !isSpaceUuid(body.teamId) ||
    !isSpaceUuid(body.materialId) ||
    (destination !== undefined &&
      destination !== null &&
      destination !== '' &&
      !isSpaceUuid(destination)) ||
    typeof body.idempotencyKey !== 'string' ||
    !IDEMPOTENCY.test(body.idempotencyKey) ||
    // A catalog variant has its own trusted route (T041); a member never names one.
    body.idempotencyKey.startsWith('catalog-variant:') ||
    typeof body.toolId !== 'string' ||
    !Object.hasOwn(PROCESS_TOOL_RULES, body.toolId) ||
    // No versions in an R2 space yet: an overwrite run is refused, not turned into a copy.
    (body.versionOfMaterialId !== undefined && body.versionOfMaterialId !== null) ||
    (body.conflictMode !== 'cancel' && body.conflictMode !== 'keep_both') ||
    !Number.isSafeInteger(body.agentContractVersion) ||
    (body.agentContractVersion as number) < 1 ||
    !Number.isSafeInteger(body.toolContractVersion) ||
    (body.optionsSummary !== undefined && !isRecord(body.optionsSummary))
  )
    return refuse('INVALID_INPUT');
  return {
    teamId: body.teamId,
    materialId: body.materialId,
    destinationFolderId: isSpaceUuid(destination) ? destination : null,
    idempotencyKey: body.idempotencyKey,
    toolId: body.toolId,
    outputName: displayDriveName(body.outputName),
    conflictMode: body.conflictMode,
    agentContractVersion: body.agentContractVersion as number,
    toolContractVersion: body.toolContractVersion as number
  };
}

interface SourceFacts {
  category: string | null;
  sizeBytes: number;
  destinationFolderId: string;
  childNames: string[];
}

function parseSourceFacts(value: unknown): SourceFacts {
  if (!isRecord(value)) return refuse('INVALID_RESPONSE');
  const size = parseByteCount(value.sizeBytes);
  if (
    size === null ||
    size > BigInt(Number.MAX_SAFE_INTEGER) ||
    !isSpaceUuid(value.destinationFolderId) ||
    !Array.isArray(value.childNames) ||
    !value.childNames.every(name => typeof name === 'string') ||
    (value.category !== null && typeof value.category !== 'string')
  )
    return refuse('INVALID_RESPONSE');
  return {
    category: value.category as string | null,
    sizeBytes: Number(size),
    destinationFolderId: value.destinationFolderId,
    childNames: value.childNames as string[]
  };
}

export interface IssuedGrant {
  ticket: string;
  purpose: 'process_input' | 'finalize';
  expiresAt: string;
  maxRangeBytes: number;
  maxUses: number;
}

async function issueGrant(
  deps: ProcessDeps,
  input: {
    purpose: IssuedGrant['purpose'];
    operationId: string;
    teamId: string;
    actorId: string;
    materialId: string | null;
    destinationFolderId: string;
    toolId: string;
    maxUses: number;
  }
): Promise<IssuedGrant> {
  const ticket = (deps.ticket ?? randomTicket)();
  const expiresAt = new Date(Date.now() + OPERATION_GRANT_TTL_SECONDS * 1000).toISOString();
  await call(deps.rpc, 'issue_team_transfer_grant', {
    p_token_hash: await ticketHash(ticket),
    p_operation: input.operationId,
    p_team: input.teamId,
    p_actor: input.actorId,
    p_purpose: input.purpose,
    p_material: input.materialId,
    p_destination: input.destinationFolderId,
    p_tool: input.toolId,
    p_max_range_bytes: RANGE_REQUEST_MAX_BYTES,
    p_expires_at: expiresAt,
    p_max_uses: input.maxUses
  });
  return {
    ticket,
    purpose: input.purpose,
    expiresAt,
    maxRangeBytes: RANGE_REQUEST_MAX_BYTES,
    maxUses: input.maxUses
  };
}

async function transition(
  rpc: Rpc,
  operationId: string,
  state: 'running' | 'failed',
  stage: string,
  progress: number,
  errorCode: string | null = null
) {
  await call(rpc, 'service_transition_team_operation', {
    p_operation: operationId,
    p_state: state,
    p_stage: stage,
    p_progress: progress,
    p_result_material: null,
    p_error_code: errorCode,
    p_retryable: false
  });
}

export async function startSpaceProcess(
  command: ProcessStartCommand,
  deps: ProcessDeps
): Promise<{
  operationId: string;
  state: 'running';
  sourceGrant: IssuedGrant;
  finalizeGrant: IssuedGrant;
  agentContractVersion: number;
}> {
  const actorId = deps.actorId ?? refuse('PERMISSION_DENIED');
  const tool = PROCESS_TOOL_RULES[command.toolId]!;
  if (command.toolContractVersion < tool.contractVersion) return refuse('AGENT_UPDATE_REQUIRED');
  await requireSpaceRequest(deps.rpc, {
    teamId: command.teamId,
    actorId,
    permission: 'process'
  });
  const facts = parseSourceFacts(
    await call(deps.rpc, 'service_space_process_source', {
      p_team: command.teamId,
      p_material: command.materialId,
      p_destination: command.destinationFolderId,
      p_actor: actorId
    })
  );
  if (!facts.category || !tool.categories.some(category => category === facts.category))
    return refuse('INVALID_INPUT');
  if (facts.sizeBytes > AGENT_INTAKE_MAX_BYTES) return refuse('TOO_LARGE');
  const plan = buildUploadConflictPlan(
    {
      teamId: command.teamId,
      destinationFolderId: facts.destinationFolderId,
      name: command.outputName,
      mimeType: tool.outputMimeType,
      sizeBytes: 0,
      conflictMode: command.conflictMode,
      replaceMaterialId: null,
      versionOfMaterialId: null,
      idempotencyKey: command.idempotencyKey
    },
    facts.childNames.map(name => ({ materialId: '', name }))
  );
  const started = firstRow(
    await call(deps.rpc, 'service_start_team_operation', {
      p_team: command.teamId,
      p_actor: actorId,
      p_kind: 'process',
      p_idempotency_key: command.idempotencyKey,
      p_request_nonce: `request:${command.idempotencyKey}`,
      p_source_material: command.materialId,
      p_destination_folder: facts.destinationFolderId,
      p_reserved_name_key: plan.reservationKey,
      p_reservation_expires_at: new Date(Date.now() + NAME_RESERVATION_MS).toISOString(),
      p_bytes_total: facts.sizeBytes
    })
  );
  const operationId = started && text(started, 'operation_id');
  if (!started || !operationId || !isSpaceUuid(operationId)) return refuse('INVALID_RESPONSE');
  // The same request twice: its tickets were handed out the first time and are not reissued.
  if (started.reused === true) return refuse('WRONG_STATE');
  await call(deps.rpc, 'service_set_team_operation_intent', {
    p_operation: operationId,
    p_actor: actorId,
    p_expected_name: plan.name,
    p_mime_type: tool.outputMimeType,
    p_expected_size: null,
    p_replace_material: null,
    p_version_of_material: null,
    p_tool: command.toolId,
    p_tool_contract_version: command.toolContractVersion
  });
  await transition(deps.rpc, operationId, 'running', 'awaiting_agent', 0);
  const common = {
    operationId,
    teamId: command.teamId,
    actorId,
    destinationFolderId: facts.destinationFolderId,
    toolId: command.toolId
  };
  const sourceGrant = await issueGrant(deps, {
    ...common,
    purpose: 'process_input',
    materialId: command.materialId,
    maxUses: SOURCE_TICKET_USES
  });
  const finalizeGrant = await issueGrant(deps, {
    ...common,
    purpose: 'finalize',
    materialId: command.materialId,
    maxUses: OUTPUT_TICKET_USES
  });
  return {
    operationId,
    state: 'running',
    sourceGrant,
    finalizeGrant,
    agentContractVersion: SPACE_PROCESS_AGENT_CONTRACT
  };
}

// Agent tickets -----------------------------------------------------------------------------

interface ConsumedGrant {
  operationId: string | null;
  teamId: string;
  actorId: string;
  materialId: string | null;
  toolId: string | null;
}

function ticketOf(body: Record<string, unknown>): string {
  const ticket = body.ticket;
  if (typeof ticket !== 'string' || ticket.length < 32 || ticket.length > 2048)
    return refuse('PERMISSION_DENIED');
  return ticket;
}

/** Spends one use of an agent ticket; a spent, foreign or expired one is PERMISSION_DENIED. */
async function consumeTicket(
  rpc: Rpc,
  body: Record<string, unknown>,
  purpose: 'process_input' | 'download_range' | 'finalize'
): Promise<ConsumedGrant> {
  const row = firstRow(
    await call(rpc, 'consume_team_transfer_grant', {
      p_token_hash: await ticketHash(ticketOf(body)),
      p_purpose: purpose
    })
  );
  const teamId = row && text(row, 'team_id');
  const actorId = row && text(row, 'actor_id');
  if (!row || !teamId || !actorId || !isSpaceUuid(teamId) || !isSpaceUuid(actorId))
    return refuse('PERMISSION_DENIED');
  const grant = {
    operationId: text(row, 'operation_id'),
    teamId,
    actorId,
    materialId: text(row, 'material_id'),
    toolId: text(row, 'tool_id')
  };
  // A ticket opens only the operation it was issued for.
  if (body.operationId !== undefined && body.operationId !== grant.operationId)
    return refuse('PERMISSION_DENIED');
  return grant;
}

function uploadDeps(deps: ProcessDeps, grant: ConsumedGrant) {
  return {
    actorId: grant.actorId,
    rpc: deps.rpc,
    bucket: deps.bucket ?? refuse('STORAGE_UNAVAILABLE'),
    journal: deps.journal,
    operationId: deps.operationId,
    client: deps.client,
    signal: deps.signal
  };
}

// /agent/source -----------------------------------------------------------------------------

export interface AgentSource {
  url: string;
  bytes: number;
  contentId: string;
  expiresAt: string;
}

/**
 * The bytes a ticket opens, as a files-host URL with a read grant. `process_input` is a run's
 * source; `download_range` a member's save through the agent. The grant opens the whole space
 * for at most ten minutes (R4) — the same one a member's browser holds.
 */
export async function agentSource(body: unknown, deps: ProcessDeps): Promise<AgentSource> {
  if (!isRecord(body)) return refuse('INVALID_INPUT');
  const purpose = body.purpose === 'download_range' ? 'download_range' : 'process_input';
  if (body.purpose !== undefined && body.purpose !== purpose) return refuse('INVALID_INPUT');
  const grant = await consumeTicket(deps.rpc, body, purpose);
  if (!grant.materialId || !isSpaceUuid(grant.materialId)) return refuse('PERMISSION_DENIED');
  const { materials } = await readMaterials(
    { teamId: grant.teamId, materialIds: [grant.materialId] },
    { actorId: grant.actorId, rpc: deps.rpc }
  );
  const material = materials.find(item => item.id === grant.materialId);
  if (
    !material ||
    material.kind !== 'file' ||
    material.lifecycle !== 'active' ||
    !isSpaceContentId(material.contentId) ||
    material.sizeBytes === null
  )
    return refuse('NOT_FOUND');
  const bytes = parseByteCount(material.sizeBytes);
  if (bytes === null || bytes > BigInt(SPACE_STORAGE_LIMITS.maxObjectBytes))
    return refuse('INVALID_RESPONSE');
  const read = await issueReadGrant(
    { teamId: grant.teamId },
    {
      actorId: grant.actorId,
      rpc: deps.rpc,
      config: deps.readGrant,
      journal: deps.journal,
      operationId: deps.operationId,
      client: deps.client
    }
  );
  return {
    url: spaceFilesUrl({
      filesOrigin: read.filesOrigin,
      teamId: grant.teamId,
      contentId: material.contentId,
      grant: read.grant
    }),
    bytes: Number(bytes),
    contentId: material.contentId,
    expiresAt: read.expiresAt
  };
}

// /materials/agent-grant --------------------------------------------------------------------

/**
 * A member's save of an R2 file through the agent: a `download_range` ticket for one material,
 * which the agent trades at `/agent/source` (T033). The web builds the agent's address itself;
 * the ticket lives as long as a run's so a long save can renew its read grant.
 */
export async function issueAgentDownloadGrant(
  body: unknown,
  deps: ProcessDeps
): Promise<{
  fileName: string;
  grant: Omit<IssuedGrant, 'purpose'> & { purpose: 'download_range' };
}> {
  const actorId = deps.actorId ?? refuse('PERMISSION_DENIED');
  if (!isRecord(body) || !isSpaceUuid(body.teamId) || !isSpaceUuid(body.materialId))
    return refuse('INVALID_INPUT');
  await requireSpaceRequest(deps.rpc, { teamId: body.teamId, actorId, permission: 'download' });
  const { materials } = await readMaterials(
    { teamId: body.teamId, materialIds: [body.materialId] },
    { actorId, rpc: deps.rpc }
  );
  const material = materials.find(item => item.id === body.materialId);
  if (!material || material.kind !== 'file' || material.lifecycle !== 'active')
    return refuse('NOT_FOUND');
  const ticket = (deps.ticket ?? randomTicket)();
  const expiresAt = new Date(Date.now() + OPERATION_GRANT_TTL_SECONDS * 1000).toISOString();
  await call(deps.rpc, 'issue_team_transfer_grant', {
    p_token_hash: await ticketHash(ticket),
    p_operation: null,
    p_team: body.teamId,
    p_actor: actorId,
    p_purpose: 'download_range',
    p_material: body.materialId,
    p_destination: null,
    p_tool: null,
    p_max_range_bytes: RANGE_REQUEST_MAX_BYTES,
    p_expires_at: expiresAt,
    p_max_uses: SOURCE_TICKET_USES
  });
  return {
    fileName: material.name,
    grant: {
      ticket,
      purpose: 'download_range',
      expiresAt,
      maxRangeBytes: RANGE_REQUEST_MAX_BYTES,
      maxUses: SOURCE_TICKET_USES
    }
  };
}

// /process/output/* -------------------------------------------------------------------------

interface RunningOperation {
  operationId: string;
  teamId: string;
  state: string;
  kind: string;
  sourceMaterialId: string | null;
  destinationFolderId: string | null;
  resultMaterialId: string | null;
  expectedName: string | null;
  mimeType: string | null;
  versionOfMaterialId: string | null;
  toolId: string | null;
  toolContractVersion: number | null;
}

async function operationOf(rpc: Rpc, grant: ConsumedGrant): Promise<RunningOperation> {
  if (!grant.operationId) return refuse('PERMISSION_DENIED');
  const row = firstRow(
    await call(rpc, 'service_get_team_operation', {
      p_operation: grant.operationId,
      p_actor: grant.actorId
    })
  );
  const operationId = row && text(row, 'operation_id');
  if (!row || operationId !== grant.operationId || text(row, 'team_id') !== grant.teamId)
    return refuse('INVALID_RESPONSE');
  return {
    operationId,
    teamId: grant.teamId,
    state: text(row, 'state') ?? '',
    kind: text(row, 'kind') ?? '',
    sourceMaterialId: text(row, 'source_material_id'),
    destinationFolderId: text(row, 'destination_folder_id'),
    resultMaterialId: text(row, 'result_material_id'),
    expectedName: text(row, 'expected_name'),
    mimeType: text(row, 'mime_type'),
    versionOfMaterialId: text(row, 'version_of_material_id'),
    toolId: text(row, 'tool_id'),
    toolContractVersion: Number.isSafeInteger(row.tool_contract_version)
      ? (row.tool_contract_version as number)
      : null
  };
}

function requireRunning(operation: RunningOperation, grant: ConsumedGrant) {
  if (
    operation.kind !== 'process' ||
    operation.state !== 'running' ||
    operation.toolId !== grant.toolId ||
    !operation.expectedName ||
    !operation.mimeType ||
    operation.versionOfMaterialId !== null
  )
    refuse('WRONG_STATE');
}

const outputKey = (operationId: string) => `process_output_${operationId}`;

/** The output upload the database bound to this run, if one was opened. */
async function outputUploadOf(rpc: Rpc, grant: ConsumedGrant) {
  const value = await call(rpc, 'service_space_process_upload', {
    p_operation: grant.operationId,
    p_actor: grant.actorId
  });
  if (!isRecord(value)) return refuse('INVALID_RESPONSE');
  return {
    operationState: typeof value.operationState === 'string' ? value.operationState : '',
    uploadId: isSpaceUuid(value.uploadId) ? value.uploadId : null,
    uploadState: typeof value.uploadState === 'string' ? value.uploadState : null
  };
}

export type ProcessOutputSession =
  | {
      kind: 'session';
      uploadId: string;
      partBytes: number;
      partCount: number;
      expiresAt: string;
    }
  | { kind: 'exists'; uploadId: string; materialId: string };

export async function startProcessOutput(
  body: unknown,
  deps: ProcessDeps
): Promise<ProcessOutputSession> {
  if (!isRecord(body)) return refuse('INVALID_INPUT');
  // Checked before the ticket is spent: a Drive-protocol agent must update, and its ticket
  // stays good for the run it can still finish once updated.
  if (body.outputUploadProtocolVersion !== SPACE_OUTPUT_UPLOAD_PROTOCOL)
    return refuse('AGENT_UPDATE_REQUIRED');
  const bytes = body.bytes;
  if (
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 1 ||
    !isSpaceContentId(body.contentId) ||
    (body.derivatives !== undefined && !Array.isArray(body.derivatives))
  )
    return refuse('INVALID_INPUT');
  if ((bytes as number) > SPACE_STORAGE_LIMITS.maxObjectBytes)
    return refuse('STORAGE_OBJECT_TOO_LARGE');
  const grant = await consumeTicket(deps.rpc, body, 'finalize');
  const operation = await operationOf(deps.rpc, grant);
  requireRunning(operation, grant);
  await call(deps.rpc, 'service_set_team_operation_intent', {
    p_operation: operation.operationId,
    p_actor: grant.actorId,
    p_expected_name: operation.expectedName,
    p_mime_type: operation.mimeType,
    p_expected_size: bytes,
    p_replace_material: null,
    p_version_of_material: null,
    p_tool: operation.toolId,
    p_tool_contract_version: operation.toolContractVersion
  });
  const admitted = await admitUpload(
    {
      teamId: grant.teamId,
      parentMaterialId: operation.destinationFolderId,
      name: operation.expectedName!,
      // The run's declared output type, not the agent's: the file is what the tool makes.
      contentType: operation.mimeType!,
      bytes: BigInt(bytes as number),
      contentId: body.contentId,
      sha256: null,
      ingress: 'agent_output',
      idempotencyKey: outputKey(operation.operationId)
    },
    uploadDeps(deps, grant)
  );
  await transition(deps.rpc, operation.operationId, 'running', 'uploading', 75);
  if (admitted.kind === 'exists') {
    const upload = await outputUploadOf(deps.rpc, grant);
    if (!upload.uploadId) return refuse('INVALID_RESPONSE');
    return { kind: 'exists', uploadId: upload.uploadId, materialId: admitted.materialId };
  }
  return {
    kind: 'session',
    uploadId: admitted.uploadId,
    partBytes: admitted.partBytes,
    partCount: admitted.partCount,
    expiresAt: admitted.expiresAt
  };
}

async function requireOwnUpload(rpc: Rpc, grant: ConsumedGrant, uploadId: unknown) {
  if (!isSpaceUuid(uploadId)) return refuse('INVALID_INPUT');
  const upload = await outputUploadOf(rpc, grant);
  if (upload.uploadId !== uploadId) return refuse('PERMISSION_DENIED');
  return upload;
}

export async function signProcessOutputParts(
  body: unknown,
  deps: ProcessDeps
): Promise<{ parts: { partNumber: number; url: string; expiresAt: string }[] }> {
  if (!isRecord(body) || !Array.isArray(body.parts)) return refuse('INVALID_INPUT');
  const grant = await consumeTicket(deps.rpc, body, 'finalize');
  await requireOwnUpload(deps.rpc, grant, body.uploadId);
  const parts: { partNumber: number; md5: string }[] = [];
  for (const part of body.parts) {
    if (
      !isRecord(part) ||
      !Number.isSafeInteger(part.partNumber) ||
      typeof part.md5 !== 'string' ||
      !/^[0-9a-f]{32}$/u.test(part.md5)
    )
      return refuse('INVALID_INPUT');
    parts.push({ partNumber: part.partNumber as number, md5: part.md5 });
  }
  if (parts.length < 1 || parts.length > SPACE_STORAGE_LIMITS.partUrlBatch)
    return refuse('INVALID_INPUT');
  return signUploadParts(
    body.uploadId as string,
    { teamId: grant.teamId, parts },
    uploadDeps(deps, grant)
  );
}

export interface ProcessFinalized {
  operationId: string;
  state: 'succeeded';
  materialId: string;
  reused: boolean;
}

function parseFinalized(value: unknown): ProcessFinalized {
  if (
    !isRecord(value) ||
    !isSpaceUuid(value.operationId) ||
    value.state !== 'succeeded' ||
    !isSpaceUuid(value.materialId) ||
    typeof value.reused !== 'boolean'
  )
    return refuse('INVALID_RESPONSE');
  return {
    operationId: value.operationId,
    state: 'succeeded',
    materialId: value.materialId,
    reused: value.reused
  };
}

export async function finalizeProcessOutput(
  body: unknown,
  deps: ProcessDeps
): Promise<ProcessFinalized> {
  if (!isRecord(body)) return refuse('INVALID_INPUT');
  const grant = await consumeTicket(deps.rpc, body, 'finalize');
  const operation = await operationOf(deps.rpc, grant);
  const finalize = async () =>
    parseFinalized(
      await call(deps.rpc, 'service_finalize_space_process_output', {
        p_operation: operation.operationId,
        p_actor: grant.actorId,
        p_upload: body.uploadId
      })
    );
  // A finalize whose reply was lost: the run already holds its result.
  if (operation.state === 'succeeded') return finalize();
  requireRunning(operation, grant);
  await requireOwnUpload(deps.rpc, grant, body.uploadId);
  try {
    await completeUpload(
      body.uploadId as string,
      { teamId: grant.teamId },
      uploadDeps(deps, grant)
    );
  } catch (cause) {
    // The stored parts are not the output the agent declared: nothing was committed, and the run
    // cannot succeed with these bytes.
    if (cause instanceof TeamFunctionError && cause.code === 'CHECKSUM_MISMATCH')
      await transition(
        deps.rpc,
        operation.operationId,
        'failed',
        'failed',
        100,
        'CHECKSUM_MISMATCH'
      ).catch(() => undefined);
    throw cause;
  }
  const finalized = await finalize();
  // 012: a transcription is its video's transcript companion. Best-effort, as on Drive: the
  // text file is committed either way. The fingerprint comes only from this ticketed path.
  if (!finalized.reused && operation.toolId === 'transcription' && operation.sourceMaterialId) {
    const fingerprint =
      typeof body.audioFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(body.audioFingerprint)
        ? body.audioFingerprint
        : null;
    await call(deps.rpc, 'service_link_transcript_companion', {
      p_team: grant.teamId,
      p_video: operation.sourceMaterialId,
      p_companion: finalized.materialId,
      p_fingerprint: fingerprint,
      p_text: null
    }).catch(() => undefined);
  }
  return finalized;
}

/** The agent settled without a result: an output session still open is closed. Repeatable. */
export async function acknowledgeProcessQuiesced(
  body: unknown,
  deps: ProcessDeps
): Promise<{ acknowledged: true }> {
  if (!isRecord(body) || !isSpaceUuid(body.operationId)) return refuse('INVALID_INPUT');
  const grant = await consumeTicket(deps.rpc, body, 'finalize');
  const upload = await outputUploadOf(deps.rpc, grant);
  if (
    upload.operationState !== 'succeeded' &&
    upload.uploadId &&
    // Only a session nobody is completing: a `completing` one may already be whole in R2 and is
    // settled by its finalize retry or by reconciliation, never by aborting under it.
    upload.uploadState === 'open'
  ) {
    await abortUpload(upload.uploadId, { teamId: grant.teamId }, uploadDeps(deps, grant)).catch(
      () => undefined
    );
  }
  return { acknowledged: true };
}
