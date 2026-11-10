// @deno-types="../../../packages/shared/dist/team/transport.d.ts"
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode
} from '../../../packages/shared/dist/team/transport.js';
import { isRecord } from './validation.ts';
import { TeamFunctionError } from './errors.ts';
import type { ServiceRpcClient } from './credentials.ts';

export type CatalogVideoR2Rpc = ServiceRpcClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function videoR2Id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TeamFunctionError('INVALID_INPUT');
  return value;
}
export function videoR2Object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TeamFunctionError('INVALID_RESPONSE');
  return value;
}
export function videoR2String(value: unknown, max = 255): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw new TeamFunctionError('INVALID_RESPONSE');
  return value;
}
export function videoR2Integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new TeamFunctionError('INVALID_RESPONSE');
  return value;
}

function knownCode(value: string): value is TeamErrorCode {
  return TEAM_ERROR_CODES.some(code => code === value);
}

/** Database errors carry a closed code in their message; anything else is the provider being unavailable. */
export async function videoR2Rpc(
  client: CatalogVideoR2Rpc,
  name: string,
  parameters: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await client.rpc(name, parameters);
  if (error) {
    const code = error.message?.match(/[A-Z][A-Z0-9_]+/gu)?.find(knownCode);
    throw new TeamFunctionError(code ?? 'VIDEO_R2_PROVIDER_UNAVAILABLE', {
      retryable:
        !code ||
        ['VIDEO_R2_PROVIDER_UNAVAILABLE', 'VIDEO_R2_PROVIDER_RATE_LIMITED', 'LEASE_MISMATCH'].includes(
          code
        )
    });
  }
  return data;
}

/** Admission is shared by every request handled by this Deno isolate. */
export function createCatalogVideoR2Permit() {
  let held = false;
  return {
    acquire(): (() => void) | null {
      if (held) return null;
      held = true;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          held = false;
        }
      };
    }
  };
}
