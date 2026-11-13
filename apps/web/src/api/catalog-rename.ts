import {
  parseCatalogRenameContext,
  parseCatalogRenameRequest,
  parseCatalogRenameReceipt,
  type CatalogRenameContext,
  type CatalogRenameRequest,
  type CatalogRenameReceipt
} from '@video-compressor/shared';
import { invokeTeamFunction, TeamApiError } from './team.js';
import { privateCacheActor, privateCacheEpoch } from '../team/private-cache-scope.js';

export interface CatalogRenameRead {
  teamId: string;
  materialId: string;
  expectedActorId: string;
}
export interface CatalogRenameClient {
  context(input: CatalogRenameRead, signal?: AbortSignal): Promise<CatalogRenameContext>;
  submit(input: CatalogRenameRequest, signal?: AbortSignal): Promise<CatalogRenameReceipt>;
  status(
    input: CatalogRenameRead & { requestKey: string },
    signal?: AbortSignal
  ): Promise<CatalogRenameReceipt | null>;
}
function capture(expectedActorId: string) {
  const epoch = privateCacheEpoch();
  const check = () => {
    if (privateCacheActor() !== expectedActorId || privateCacheEpoch() !== epoch)
      throw new TeamApiError('PERMISSION_DENIED', false);
  };
  check();
  return check;
}
export function matchingCatalogRenameReceipt(
  value: unknown,
  input: { teamId: string; materialId: string; requestKey: string }
) {
  const receipt = parseCatalogRenameReceipt(value);
  if (
    !receipt ||
    receipt.teamId !== input.teamId ||
    receipt.materialId !== input.materialId ||
    receipt.requestKey !== input.requestKey
  )
    throw new TeamApiError('INVALID_RESPONSE', false);
  return receipt;
}
export const catalogRenameApi: CatalogRenameClient = {
  async context(input, signal) {
    const current = capture(input.expectedActorId);
    const result = await invokeTeamFunction(
      'drive-ops/catalogs/rename-context',
      { ...input },
      (value): value is CatalogRenameContext => parseCatalogRenameContext(value) !== null,
      { signal }
    );
    current();
    if (result.teamId !== input.teamId || result.materialId !== input.materialId)
      throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async submit(input, signal) {
    const current = capture(input.expectedActorId);
    const command = parseCatalogRenameRequest(input);
    if (!command) throw new TeamApiError('INVALID_INPUT', false);
    const result = await invokeTeamFunction(
      'drive-ops/catalogs/rename',
      { ...command },
      (value): value is CatalogRenameReceipt => parseCatalogRenameReceipt(value) !== null,
      { signal }
    );
    current();
    return matchingCatalogRenameReceipt(result, command);
  },
  async status(input, signal) {
    const current = capture(input.expectedActorId);
    const result = await invokeTeamFunction(
      'drive-ops/catalogs/rename-status',
      { ...input },
      (value): value is CatalogRenameReceipt | null =>
        value === null || parseCatalogRenameReceipt(value) !== null,
      { signal }
    );
    current();
    return result === null ? null : matchingCatalogRenameReceipt(result, input);
  }
};
