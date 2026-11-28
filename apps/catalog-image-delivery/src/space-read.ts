import {
  createCachedEpochReader,
  handleSpaceRead,
  safeDownloadDisposition,
  type SpaceReadBucket,
  type SpaceReadCache,
  type SpaceReadContext,
  type SpaceReadDeps,
  type SpaceReadObject,
  type SpaceReadObjectBody
} from '../../../packages/shared/src/team/space-read.js';

/**
 * 057 `space-read` on the files host (contracts/storage-api.md «Worker `space-read`», research
 * R4). The request handling is the shared core in `packages/shared/src/team/space-read.ts`,
 * which `space-storage` also serves on beta; this file adds what only the Worker has: the
 * epoch read over PostgREST.
 */
export {
  createCachedEpochReader,
  handleSpaceRead,
  safeDownloadDisposition,
  type SpaceReadBucket,
  type SpaceReadCache,
  type SpaceReadContext,
  type SpaceReadDeps,
  type SpaceReadObject,
  type SpaceReadObjectBody
};

/**
 * `service_space_read_epoch(p_team)` over PostgREST with the service key: a JSON string of
 * decimal digits, or null when the space is not an active R2 space. Anything else throws.
 */
export function supabaseEpochLoader(input: {
  supabaseUrl: string;
  serviceKey: string;
  fetcher: (input: Request) => Promise<Response>;
}): (teamId: string) => Promise<bigint | null> {
  const endpoint = new URL('/rest/v1/rpc/service_space_read_epoch', input.supabaseUrl).toString();
  return async teamId => {
    const response = await input.fetcher(
      new Request(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          apikey: input.serviceKey,
          authorization: `Bearer ${input.serviceKey}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({ p_team: teamId }),
        signal: AbortSignal.timeout(5_000)
      })
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Epoch lookup failed: ${response.status}`);
    }
    const text = await response.text();
    if (text.length > 64) throw new Error('Epoch lookup malformed');
    const value: unknown = JSON.parse(text);
    if (value === null) return null;
    if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
      const epoch = BigInt(value);
      if (epoch <= 9_223_372_036_854_775_807n) return epoch;
    }
    throw new Error('Epoch lookup malformed');
  };
}
