/**
 * `/read-grant` (057 T027, research R4, contracts/storage-api.md «Worker space-read»).
 *
 * A member who may view an R2 space gets a grant for that one space for at most ten minutes:
 * HMAC over user, team and the space's current `access_epoch`
 * (packages/shared/src/team/space-read-grant.ts, the same bytes the Worker verifies). Raising
 * the epoch revokes it within the Worker's 30-second cache. The grant rides in `?g=` on the
 * files host, so it is never written to the journal, a log or an error.
 */
// @deno-types="../../../packages/shared/dist/team/space-read-grant.d.ts"
import {
  importSpaceReadGrantKey,
  signSpaceReadGrant,
  type SpaceGrantEnvironment
} from '../../../packages/shared/dist/team/space-read-grant.js';
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import {
  SPACE_STORAGE_LIMITS,
  type SpaceReadGrantResult
} from '../../../packages/shared/dist/team/space-storage.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceStorageJournalEntry } from '../_shared/space-storage-journal.ts';
import { requireSpaceRequest, type Rpc } from './handler.ts';

export interface SpaceReadGrantConfig {
  environment: SpaceGrantEnvironment;
  keyVersion: number;
  key: CryptoKey;
  filesOrigin: string;
}

/**
 * `SPACE_READ_GRANT_KEYS` (JSON `{"<version>": "<base64 key>"}`, the same secret the Worker
 * holds), `SPACE_READ_GRANT_KEY_VERSION` (the version that signs) and `SPACE_FILES_ORIGIN`.
 * Anything missing or malformed → null, and the route answers STORAGE_UNAVAILABLE.
 */
export async function readSpaceReadGrantConfig(
  env: (key: string) => string | undefined
): Promise<SpaceReadGrantConfig | null> {
  const environment = env('CATALOG_IMAGES_ENVIRONMENT');
  const origin = env('SPACE_FILES_ORIGIN');
  const version = env('SPACE_READ_GRANT_KEY_VERSION');
  const keys = env('SPACE_READ_GRANT_KEYS');
  if (
    (environment !== 'dev' && environment !== 'beta' && environment !== 'production') ||
    !origin ||
    !version ||
    !/^[1-9][0-9]{0,4}$/u.test(version) ||
    Number(version) > 65535 ||
    !keys ||
    keys.length > 4096
  )
    return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) return null;
    const parsed: unknown = JSON.parse(keys);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const encoded = (parsed as Record<string, unknown>)[version];
    if (typeof encoded !== 'string' || encoded.length > 172) return null;
    const key = await importSpaceReadGrantKey(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
    return { environment, keyVersion: Number(version), key, filesOrigin: origin };
  } catch {
    return null;
  }
}

export interface ReadGrantDeps {
  actorId: string;
  rpc: Rpc;
  config: SpaceReadGrantConfig | null;
  journal: (entry: SpaceStorageJournalEntry) => Promise<unknown>;
  operationId: string;
  client: SpaceStorageJournalEntry['client'];
  nowSeconds?: () => number;
}

export async function issueReadGrant(
  command: { teamId: string },
  deps: ReadGrantDeps
): Promise<SpaceReadGrantResult> {
  const record = (outcome: SpaceStorageJournalEntry['outcome'], code: string | null) =>
    deps
      .journal({
        operationId: deps.operationId,
        attempt: 1,
        stage: 'read_grant',
        outcome,
        code,
        bytes: null,
        teamId: command.teamId,
        ingress: null,
        client: deps.client
      })
      .catch(() => undefined);
  try {
    const context = await requireSpaceRequest(deps.rpc, {
      teamId: command.teamId,
      actorId: deps.actorId,
      permission: 'view'
    });
    if (!deps.config) throw new TeamFunctionError('STORAGE_UNAVAILABLE');
    const issuedAt = Math.floor(deps.nowSeconds?.() ?? Date.now() / 1000);
    const expiresAt = issuedAt + SPACE_STORAGE_LIMITS.readGrantTtlSeconds;
    const grant = await signSpaceReadGrant(
      {
        environment: deps.config.environment,
        keyVersion: deps.config.keyVersion,
        teamId: command.teamId,
        userId: deps.actorId,
        accessEpoch: context.accessEpoch,
        issuedAt,
        expiresAt
      },
      deps.config.key
    );
    await record('ok', null);
    return {
      grant,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      filesOrigin: deps.config.filesOrigin
    };
  } catch (cause) {
    const error =
      cause instanceof TeamFunctionError ? cause : new TeamFunctionError('STORAGE_UNAVAILABLE');
    await record(error.retryable ? 'failed' : 'rejected', error.code);
    throw error;
  }
}
