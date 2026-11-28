/**
 * space-storage (057): the pure checks every route shares.
 *
 * Nothing here touches Deno, the network or the database: the entry (`index.ts`) hands in the
 * request facts and an RPC, so vitest drives every rule with a fake. The five server checks of
 * contracts/storage-api.md, in the order a request meets them:
 *
 *   4. the client declared `storage-r2/1` — checked first, before any database read, so an old
 *      client is told to update rather than anything about the space;
 *   1. the person is an active member of the space;
 *   2. the space is on R2;
 *   3. a pilot space is opened only by a person who holds the pilot permit themselves. A
 *      service call has no `auth.uid()`, so the database gate answers for the owner — this
 *      function has to look at the ACTING person's permit, which the context carries;
 *   5. the space is not archived and not paused by its tariff;
 *   and finally the role allows the action (`private.can` semantics).
 */
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import {
  declaresSpaceStorage,
  isSpaceUuid,
  isStorageBackend,
  parseByteCount,
  parseSpaceCreated,
  SPACE_STORAGE_CAPABILITY_HEADER,
  type StorageBackend
} from '../../../packages/shared/dist/team/space-storage.js';
import { knownTeamErrorCode, TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** The routes this function answers; anything else is NOT_FOUND. `{id}` is an upload id. */
export const SPACE_STORAGE_ROUTES = [
  '/spaces/create',
  '/uploads/admit',
  '/uploads/{id}/parts',
  '/uploads/{id}/complete',
  '/uploads/{id}/abort',
  '/uploads/{id}/derivatives',
  '/derivatives/claim',
  '/materials/mutate',
  '/materials/read',
  '/trash/empty',
  '/read-grant',
  '/process/start',
  '/catalog-variants/run',
  '/materials/agent-grant',
  '/agent/source',
  '/process/output/start',
  '/process/output/parts',
  '/process/output/finalize',
  '/process/output/quiesced',
  '/agent/derivatives/stage',
  '/agent/derivatives/finish'
] as const;
export type SpaceStorageRoute = (typeof SPACE_STORAGE_ROUTES)[number];

/**
 * The routes the desktop agent calls with an operation ticket instead of a member's session
 * (T033). The ticket names the person and the space; the entry skips the JWT check for these
 * and only these.
 */
export const SPACE_STORAGE_TICKET_ROUTES: ReadonlySet<SpaceStorageRoute> = new Set([
  '/agent/source',
  '/process/output/start',
  '/process/output/parts',
  '/process/output/finalize',
  '/process/output/quiesced',
  // T047: the agent's derivative backfill, with the lease a member's page handed it.
  '/agent/derivatives/stage',
  '/agent/derivatives/finish'
]);

const UPLOAD_PATH =
  /^\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(parts|complete|abort|derivatives)$/u;

/** The route of a path and, for an upload route, the upload it names. */
export function spaceStorageRouteMatch(path: string): {
  route: SpaceStorageRoute;
  uploadId: string | null;
} {
  const upload = UPLOAD_PATH.exec(path);
  if (upload)
    return {
      route: `/uploads/{id}/${upload[2]}` as SpaceStorageRoute,
      uploadId: upload[1]!
    };
  return { route: spaceStorageRoute(path), uploadId: null };
}

/** The path after `/space-storage`, as `routePath()` in drive-ops reads it. */
export function spaceStorageRoutePath(url: URL): string {
  const marker = '/space-storage';
  const index = url.pathname.lastIndexOf(marker);
  return index < 0 ? '/' : url.pathname.slice(index + marker.length) || '/';
}

export function spaceStorageRoute(path: string): SpaceStorageRoute {
  const route = SPACE_STORAGE_ROUTES.find(
    candidate => candidate === path && !candidate.includes('{')
  );
  if (!route) throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  return route;
}

/** Check 4: a client that cannot speak to an R2 space is told to update, never served. */
export function requireSpaceStorageClient(headers: Headers): void {
  if (!declaresSpaceStorage(headers.get(SPACE_STORAGE_CAPABILITY_HEADER))) {
    throw new TeamFunctionError('CLIENT_UPDATE_REQUIRED', { retryable: false });
  }
}

const CLIENT = /^(web|agent)\/([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:\+[0-9]{1,6})?)$/u;

/** Who is calling, for the journal: `x-soty-client: web/1.8.0+110`. Unknown → the server itself. */
export function spaceStorageClient(
  headers: Headers,
  serverVersion: string
): { kind: 'web' | 'agent' | 'server'; version: string } {
  const match = CLIENT.exec(headers.get('x-soty-client') ?? '');
  if (match) return { kind: match[1] as 'web' | 'agent', version: match[2] };
  return { kind: 'server', version: serverVersion };
}

/** The facts `service_space_storage_context` returns for one person and one space. */
export interface SpaceStorageContext {
  member: boolean;
  storageBackend: StorageBackend;
  storagePilot: boolean;
  actorPilot: boolean;
  workspaceAllowed: boolean;
  archived: boolean;
  allowed: boolean;
  accessEpoch: bigint;
  contentRevision: bigint;
  rootMaterialId: string | null;
}

export function parseSpaceStorageContext(value: unknown): SpaceStorageContext | null {
  if (!isRecord(value)) return null;
  const flags = [
    'member',
    'storagePilot',
    'actorPilot',
    'workspaceAllowed',
    'archived',
    'allowed'
  ] as const;
  if (flags.some(flag => typeof value[flag] !== 'boolean')) return null;
  const accessEpoch = parseByteCount(value.accessEpoch);
  const contentRevision = parseByteCount(value.contentRevision);
  if (
    !isStorageBackend(value.storageBackend) ||
    accessEpoch === null ||
    contentRevision === null ||
    (value.rootMaterialId !== null && !isSpaceUuid(value.rootMaterialId))
  )
    return null;
  return {
    member: value.member as boolean,
    storageBackend: value.storageBackend,
    storagePilot: value.storagePilot as boolean,
    actorPilot: value.actorPilot as boolean,
    workspaceAllowed: value.workspaceAllowed as boolean,
    archived: value.archived as boolean,
    allowed: value.allowed as boolean,
    accessEpoch,
    contentRevision,
    rootMaterialId: value.rootMaterialId as string | null
  };
}

const refuse = (code: ConstructorParameters<typeof TeamFunctionError>[0]): never => {
  throw new TeamFunctionError(code, { retryable: false });
};

/** Checks 1, 2, 3 and 5 and the role, over a context already read. */
export function checkSpaceRequest(context: SpaceStorageContext | null): SpaceStorageContext {
  if (!context || !context.member) return refuse('PERMISSION_DENIED');
  if (context.storageBackend !== 'r2') return refuse('STORAGE_BACKEND_MISMATCH');
  if (context.storagePilot && !context.actorPilot) return refuse('R2_PILOT_REQUIRED');
  if (context.archived) return refuse('SPACE_ARCHIVED');
  if (!context.workspaceAllowed) return refuse('SPACE_BLOCKED');
  if (!context.allowed) return refuse('PERMISSION_DENIED');
  return context;
}

export type SpacePermission =
  | 'view'
  | 'download'
  | 'upload'
  | 'edit'
  | 'delete'
  | 'process'
  | 'manage_members'
  | 'manage_metadata';

/** Reads and checks the context of one request; every space route starts here. */
export async function requireSpaceRequest(
  rpc: Rpc,
  input: { teamId: string; actorId: string; permission: SpacePermission }
): Promise<SpaceStorageContext> {
  const value = await rpc('service_space_storage_context', {
    p_team: input.teamId,
    p_actor: input.actorId,
    p_permission: input.permission
  });
  if (value === null) return refuse('PERMISSION_DENIED');
  const context = parseSpaceStorageContext(value);
  if (!context) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  return checkSpaceRequest(context);
}

/** A database refusal carries its code in the message; anything else is a retryable 503. */
export function spaceRpcError(error: { message?: unknown; code?: unknown }): TeamFunctionError {
  if (error.code === '23505') return new TeamFunctionError('NAME_CONFLICT', { retryable: false });
  const candidates = [error.message, error.code]
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.match(/[A-Z][A-Z0-9_]+/gu) ?? []);
  for (const candidate of candidates) {
    const code = knownTeamErrorCode(candidate);
    if (code) return new TeamFunctionError(code);
  }
  return new TeamFunctionError('STORAGE_UNAVAILABLE', { retryable: true });
}

// /spaces/create ---------------------------------------------------------------------------

export interface CreateSpaceCommand {
  name: string;
  idempotencyKey: string;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/u;

export function parseCreateSpaceCommand(body: unknown): CreateSpaceCommand {
  if (!isRecord(body) || typeof body.name !== 'string' || typeof body.idempotencyKey !== 'string')
    return refuse('INVALID_INPUT');
  const name = body.name.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (name.length < 1 || name.length > 120 || !IDEMPOTENCY_KEY.test(body.idempotencyKey))
    return refuse('INVALID_INPUT');
  return { name, idempotencyKey: body.idempotencyKey };
}

const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
const PERMISSIONS = [
  'view',
  'download',
  'upload',
  'edit',
  'delete',
  'process',
  'manage_members',
  'manage_metadata'
] as const;

/** The space a creation returns: the contract's three fields and what a lobby card needs. */
export interface CreatedSpaceSnapshot {
  teamId: string;
  rootMaterialId: string;
  storageBackend: 'r2';
  storagePilot: boolean;
  name: string;
  role: (typeof ROLES)[number];
  permissions: Record<(typeof PERMISSIONS)[number], boolean>;
  connectionState: 'none';
  contentRevision: string;
}

export function parseCreatedSpaceSnapshot(value: unknown): CreatedSpaceSnapshot | null {
  const created = parseSpaceCreated(value);
  if (!created.ok || !isRecord(value)) return null;
  const { name, role, permissions, storagePilot, contentRevision } = value;
  if (
    typeof name !== 'string' ||
    name.length < 1 ||
    name.length > 120 ||
    !ROLES.some(known => known === role) ||
    typeof storagePilot !== 'boolean' ||
    parseByteCount(contentRevision) === null ||
    !isRecord(permissions) ||
    !PERMISSIONS.every(flag => typeof permissions[flag] === 'boolean')
  )
    return null;
  return {
    ...created.value,
    storagePilot,
    name,
    role: role as CreatedSpaceSnapshot['role'],
    permissions: Object.fromEntries(
      PERMISSIONS.map(flag => [flag, permissions[flag] as boolean])
    ) as CreatedSpaceSnapshot['permissions'],
    connectionState: 'none',
    contentRevision: contentRevision as string
  };
}
