import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import { requireNamedWorkerSecret } from '../_shared/auth.ts';
import { knownTeamErrorCode, TeamFunctionError } from '../_shared/errors.ts';
import { CatalogVideoR2, readCatalogVideoR2Config } from '../_shared/r2-catalog-video.ts';
import { readSpaceR2Config, SpaceR2 } from '../_shared/r2-space.ts';
import { handleSpaceStorageSweeperRequest, runSpaceStorageSweeper } from './sweeper.ts';

/**
 * 057 T059: the sweeper of R2 spaces, woken by pg_cron through the catalog-sync vault entries
 * (`private.invoke_space_storage_sweeper`, 20261226380000) with the scheduler's named secret.
 * The space bucket uses the `R2_SPACE_*` secrets; the catalogs' public bucket and its zone purge
 * use the same 050 configuration (`R2_CATALOG_*`, `R2_CATALOG_PURGE_TOKEN`) as catalog-video-r2.
 */
const env = (key: string) => Deno.env.get(key);

function service() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new TeamFunctionError('STORAGE_UNAVAILABLE', { retryable: true });
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) })
    }
  });
  return async (name: string, parameters: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(name, parameters);
    if (error) {
      const code = error.message
        ?.match(/[A-Z][A-Z0-9_]+/gu)
        ?.map(knownTeamErrorCode)
        .find(Boolean);
      throw new TeamFunctionError(code ?? 'STORAGE_UNAVAILABLE', { retryable: true });
    }
    return data;
  };
}

Deno.serve(request =>
  handleSpaceStorageSweeperRequest(request, {
    authorize: req => requireNamedWorkerSecret(req),
    run: async route => {
      const spaceConfig = readSpaceR2Config(env);
      const space = spaceConfig
        ? new SpaceR2(
            spaceConfig,
            new AwsClient({
              accessKeyId: spaceConfig.accessKeyId,
              secretAccessKey: spaceConfig.secretAccessKey,
              service: 's3',
              region: 'auto'
            }),
            (input, init) => fetch(input, init)
          )
        : null;
      const catalogConfig = readCatalogVideoR2Config(env);
      const accessKeyId = env('R2_CATALOG_VIDEO_ACCESS_KEY_ID');
      const secretAccessKey = env('R2_CATALOG_VIDEO_SECRET_ACCESS_KEY');
      const catalog =
        catalogConfig && accessKeyId && secretAccessKey
          ? new CatalogVideoR2(
              catalogConfig,
              new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
            )
          : null;
      return runSpaceStorageSweeper(
        {
          rpc: service(),
          space,
          catalog,
          route,
          worker: `space-storage-sweeper:${crypto.randomUUID()}`
        },
        AbortSignal.timeout(55_000)
      );
    }
  })
);
