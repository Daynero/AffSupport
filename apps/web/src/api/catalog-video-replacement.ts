import {
  parseCatalogVideoReplacementContext,
  parseCatalogVideoReplacementReceipt,
  parseCatalogVideoReplacementRequest,
  type CatalogVideoReplacementContext,
  type CatalogVideoReplacementReceipt,
  type CatalogVideoReplacementRequest
} from '@video-compressor/shared';
import { invokeTeamFunction, TeamApiError } from './team.js';
import { privateCacheActor, privateCacheEpoch } from '../team/private-cache-scope.js';
export interface CatalogVideoReplacementScope {
  teamId: string;
  catalogId: string;
  expectedActorId: string;
}
export interface CatalogVideoReplacementClient {
  context(
    input: CatalogVideoReplacementScope,
    signal?: AbortSignal
  ): Promise<CatalogVideoReplacementContext>;
  submit(
    input: CatalogVideoReplacementRequest,
    signal?: AbortSignal
  ): Promise<CatalogVideoReplacementReceipt>;
  status(
    input: CatalogVideoReplacementScope & { requestId: string },
    signal?: AbortSignal
  ): Promise<CatalogVideoReplacementReceipt | null>;
}
function owner(actor: string) {
  const epoch = privateCacheEpoch();
  const check = () => {
    if (privateCacheActor() !== actor || privateCacheEpoch() !== epoch)
      throw new TeamApiError('PERMISSION_DENIED', false);
  };
  check();
  return check;
}
function match(
  r: CatalogVideoReplacementReceipt,
  input: CatalogVideoReplacementScope & { requestId: string; newVideoId?: string }
) {
  if (
    r.teamId !== input.teamId ||
    r.catalogId !== input.catalogId ||
    r.requestId !== input.requestId ||
    (input.newVideoId !== undefined && r.newVideoId !== input.newVideoId)
  )
    throw new TeamApiError('INVALID_RESPONSE', false);
  return parseCatalogVideoReplacementReceipt(r)!;
}
export const catalogVideoReplacementApi: CatalogVideoReplacementClient = {
  async context(input, signal) {
    const current = owner(input.expectedActorId);
    const r = await invokeTeamFunction(
      'drive-ops/catalogs/video-replacement-context',
      { ...input },
      (v): v is CatalogVideoReplacementContext => parseCatalogVideoReplacementContext(v) !== null,
      { signal }
    );
    current();
    if (r.teamId !== input.teamId || r.catalogId !== input.catalogId)
      throw new TeamApiError('INVALID_RESPONSE', false);
    return parseCatalogVideoReplacementContext(r)!;
  },
  async submit(input, signal) {
    const current = owner(input.expectedActorId),
      request = parseCatalogVideoReplacementRequest(input);
    if (!request) throw new TeamApiError('INVALID_INPUT', false);
    const r = await invokeTeamFunction(
      'drive-ops/catalogs/replace-video',
      { ...request },
      (v): v is CatalogVideoReplacementReceipt => parseCatalogVideoReplacementReceipt(v) !== null,
      { signal }
    );
    current();
    return match(r, input);
  },
  async status(input, signal) {
    const current = owner(input.expectedActorId);
    const r = await invokeTeamFunction(
      'drive-ops/catalogs/video-replacement-status',
      { ...input },
      (v): v is CatalogVideoReplacementReceipt | null =>
        v === null || parseCatalogVideoReplacementReceipt(v) !== null,
      { signal }
    );
    current();
    return r === null ? null : match(r, input);
  }
};
