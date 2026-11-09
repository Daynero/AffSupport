import {
  parseCatalogPublicationCommand,
  parseCatalogPublicationSnapshot,
  type CatalogPublicationSnapshot
} from '../../../packages/shared/dist/team/catalog-publication-api.js';
import { TeamFunctionError } from '../_shared/errors.ts';
interface PublicationRpc {
  rpc(
    name: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}
/** Current server capability is separate from immutable command receipts. */
export function withCatalogPublicationWriter(
  snapshot: CatalogPublicationSnapshot | null,
  targetedWriterEnabled: boolean
): CatalogPublicationSnapshot | null {
  return snapshot && targetedWriterEnabled
    ? { ...snapshot, writerMode: 'video_columns' }
    : snapshot;
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
async function rpc(service: PublicationRpc, name: string, args: Record<string, unknown>) {
  const result = await service.rpc(name, args);
  if (result.error) {
    const message = result.error.message;
    if (message === 'PERMISSION_DENIED') throw new TeamFunctionError('PERMISSION_DENIED');
    if (message === 'WRONG_STATE') throw new TeamFunctionError('WRONG_STATE');
    if (message === 'SOURCE_CHANGED') throw new TeamFunctionError('SOURCE_CHANGED');
    if (message === 'INVALID_INPUT') throw new TeamFunctionError('INVALID_INPUT');
    if (message === 'NOT_FOUND') throw new TeamFunctionError('NOT_FOUND');
    if (message === 'PROCESS_RESULT_UNCERTAIN')
      throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  return result.data;
}
/** Actor comes only from the enclosing authenticated drive-ops handler. No user
 * credentials, provider URLs or installed-executor authority enter this route. */
export async function handleCatalogPublicationRead(
  service: PublicationRpc,
  actorId: string,
  body: Record<string, unknown>
): Promise<CatalogPublicationSnapshot | null> {
  if (!uuid(actorId) || !uuid(body.teamId) || !uuid(body.catalogId))
    throw new TeamFunctionError('INVALID_INPUT');
  if (body.requestId !== undefined && !uuid(body.requestId))
    throw new TeamFunctionError('INVALID_INPUT');
  const raw = await rpc(
    service,
    body.requestId === undefined
      ? 'service_read_catalog_publication'
      : 'service_read_catalog_publication_command',
    {
      p_team: body.teamId,
      p_actor: actorId,
      p_catalog: body.catalogId,
      ...(body.requestId === undefined ? {} : { p_request: body.requestId })
    }
  );
  if (raw === null) return null;
  const parsed = parseCatalogPublicationSnapshot(raw);
  if (!parsed || parsed.catalogId !== body.catalogId)
    throw new TeamFunctionError('INVALID_RESPONSE');
  return parsed;
}
export async function handleCatalogPublicationSave(
  service: PublicationRpc,
  actorId: string,
  body: Record<string, unknown>,
  serverNow = Date.now()
): Promise<CatalogPublicationSnapshot> {
  if (!uuid(actorId) || !uuid(body.teamId)) throw new TeamFunctionError('INVALID_INPUT');
  if (body.expectedActorId !== actorId) throw new TeamFunctionError('PERMISSION_DENIED');
  let command;
  try {
    command = parseCatalogPublicationCommand(body, serverNow);
  } catch {
    throw new TeamFunctionError('INVALID_INPUT');
  }
  const publication = command.publication;
  const raw = await rpc(service, 'service_save_catalog_publication', {
    p_team: body.teamId,
    p_actor: actorId,
    p_request: command.requestId,
    p_catalog: command.catalogId,
    p_expected_revision: command.expectedRevision,
    p_mode: publication.mode,
    p_due: publication.mode === 'scheduled' ? publication.dueAt : null,
    p_zone: publication.mode === 'scheduled' ? publication.timeZone : null,
    p_target: command.target
  });
  const parsed = parseCatalogPublicationSnapshot(raw);
  if (
    !parsed ||
    parsed.catalogId !== command.catalogId ||
    parsed.revision !== command.expectedRevision + 1
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return parsed;
}

export interface CatalogPublicationActionRequest {
  teamId: string;
  catalogId: string;
  requestId: string;
  expectedActorId: string;
  expectedRevision: number;
  action: 'add_now' | 'reschedule' | 'cancel';
  publication?: import('../../../packages/shared/dist/team/catalog-publication.js').CatalogVideoPublicationRequest;
}
/** Target-preserving manager actions. A canceled/held policy retains its active
 * delivery; an in-flight unknown writer is refused by the same durable CAS. */
export async function handleCatalogPublicationAction(
  service: PublicationRpc,
  actorId: string,
  body: Record<string, unknown>
): Promise<CatalogPublicationSnapshot> {
  if (body.expectedActorId !== actorId) throw new TeamFunctionError('PERMISSION_DENIED');
  if (
    !uuid(body.teamId) ||
    !uuid(body.catalogId) ||
    !uuid(body.requestId) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0 ||
    !['add_now', 'reschedule', 'cancel'].includes(String(body.action)) ||
    Object.keys(body).some(
      key =>
        ![
          'teamId',
          'catalogId',
          'requestId',
          'expectedActorId',
          'expectedRevision',
          'action',
          'publication'
        ].includes(key)
    )
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const publication =
    body.action === 'add_now'
      ? { mode: 'immediate' }
      : body.action === 'cancel'
        ? { mode: 'held' }
        : body.publication;
  if (
    (body.action !== 'reschedule' && body.publication !== undefined) ||
    !publication ||
    typeof publication !== 'object' ||
    (body.action === 'reschedule' && (publication as Record<string, unknown>).mode !== 'scheduled')
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const original = await handleCatalogPublicationRead(service, actorId, {
    teamId: body.teamId,
    catalogId: body.catalogId,
    requestId: body.requestId
  });
  if (original) {
    const requested = publication as Record<string, unknown>;
    if (
      original.revision !== Number(body.expectedRevision) + 1 ||
      original.mode !== requested.mode ||
      (requested.mode === 'scheduled' &&
        (Date.parse(original.dueAt ?? '') !== Date.parse(String(requested.dueAt)) ||
          original.timeZone !== requested.timeZone))
    )
      throw new TeamFunctionError('INVALID_INPUT');
    return original;
  }
  const current = await handleCatalogPublicationRead(service, actorId, {
    teamId: body.teamId,
    catalogId: body.catalogId
  });
  if (!current || current.revision !== body.expectedRevision)
    throw new TeamFunctionError('WRONG_STATE');
  return handleCatalogPublicationSave(
    service,
    actorId,
    {
      teamId: body.teamId,
      expectedActorId: actorId,
      requestId: body.requestId,
      catalogId: body.catalogId,
      expectedRevision: body.expectedRevision,
      publication,
      target: current.target
    },
    current.serverNow
  );
}
