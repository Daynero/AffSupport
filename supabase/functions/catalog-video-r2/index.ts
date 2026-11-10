import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import { authorizeCaller, requireNamedWorkerSecret } from '../_shared/auth.ts';
import { readDriveCredential, refreshGoogleAccessToken } from '../_shared/credentials.ts';
import { GoogleDriveClient } from '../_shared/drive.ts';
import { CatalogVideoR2, readCatalogVideoR2Config } from '../_shared/r2-catalog-video.ts';
import { TeamFunctionError, errorResponse } from '../_shared/errors.ts';
import { handleCatalogVideoR2 } from './handler.ts';
import { runCatalogVideoR2Worker } from './worker.ts';

const environmentValues: Readonly<Record<string, string | undefined>> = {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  GOOGLE_CLIENT_ID: Deno.env.get('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: Deno.env.get('GOOGLE_CLIENT_SECRET'),
  DRIVE_OAUTH_MODE: Deno.env.get('DRIVE_OAUTH_MODE'),
  WISHLY_SITE_URL: Deno.env.get('WISHLY_SITE_URL'),
  CATALOG_IMAGES_ENVIRONMENT: Deno.env.get('CATALOG_IMAGES_ENVIRONMENT'),
  CATALOG_VIDEOS_ENABLED: Deno.env.get('CATALOG_VIDEOS_ENABLED'),
  CATALOG_VIDEOS_PART_VERIFICATION: Deno.env.get('CATALOG_VIDEOS_PART_VERIFICATION'),
  R2_CATALOG_ACCOUNT_ID: Deno.env.get('R2_CATALOG_ACCOUNT_ID'),
  R2_CATALOG_VIDEO_STAGING_BUCKET: Deno.env.get('R2_CATALOG_VIDEO_STAGING_BUCKET'),
  R2_CATALOG_VIDEO_PUBLIC_BUCKET: Deno.env.get('R2_CATALOG_VIDEO_PUBLIC_BUCKET'),
  R2_CATALOG_VIDEO_PUBLIC_ORIGIN: Deno.env.get('R2_CATALOG_VIDEO_PUBLIC_ORIGIN'),
  R2_CATALOG_VIDEO_TARGET_CONFIRMATION: Deno.env.get('R2_CATALOG_VIDEO_TARGET_CONFIRMATION'),
  R2_CATALOG_VIDEO_ACCESS_KEY_ID: Deno.env.get('R2_CATALOG_VIDEO_ACCESS_KEY_ID'),
  R2_CATALOG_VIDEO_SECRET_ACCESS_KEY: Deno.env.get('R2_CATALOG_VIDEO_SECRET_ACCESS_KEY'),
  R2_CATALOG_ZONE_ID: Deno.env.get('R2_CATALOG_ZONE_ID'),
  R2_CATALOG_PURGE_TOKEN: Deno.env.get('R2_CATALOG_PURGE_TOKEN')
};
const env = (key: string) => environmentValues[key];

function service() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new TeamFunctionError('VIDEO_R2_PROVIDER_UNAVAILABLE');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) })
    }
  });
  return {
    auth: client.auth,
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      const { data, error } = await client.rpc(name, parameters);
      return { data, error };
    }
  };
}

Deno.serve(async request => {
  try {
    const client = service();
    const configured = readCatalogVideoR2Config(env);
    const accessKeyId = env('R2_CATALOG_VIDEO_ACCESS_KEY_ID');
    const secretAccessKey = env('R2_CATALOG_VIDEO_SECRET_ACCESS_KEY');
    const r2 =
      configured && accessKeyId && secretAccessKey
        ? new CatalogVideoR2(configured, new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }))
        : null;
    const enabled = env('CATALOG_VIDEOS_ENABLED') === 'true' && r2 !== null;
    const tokens = new Map<string, Promise<string>>();
    const token = (credential: string): Promise<string> => {
      let found = tokens.get(credential);
      if (!found) {
        found = readDriveCredential(client, credential)
          .then(value =>
            refreshGoogleAccessToken({
              credential: value,
              clientId: env('GOOGLE_CLIENT_ID') ?? '',
              clientSecret: env('GOOGLE_CLIENT_SECRET') ?? '',
              oauthMode: env('DRIVE_OAUTH_MODE'),
              productionSignals: { siteUrl: env('WISHLY_SITE_URL') }
            })
          )
          .then(value => value.accessToken);
        tokens.set(credential, found);
      }
      return found;
    };
    return await handleCatalogVideoR2(request, {
      service: client,
      enabled,
      configuredOrigin: r2?.config.publicOrigin ?? null,
      siteUrl: env('WISHLY_SITE_URL') ?? '',
      authorize: async req => (await authorizeCaller(req, client)).userId,
      authorizeWorker: req => requireNamedWorkerSecret(req),
      runWorker: async route =>
        r2
          ? runCatalogVideoR2Worker({
              service: client,
              r2,
              enabled,
              route,
              driveFor: async (credential, signal) =>
                new GoogleDriveClient(await token(credential), (input, init) =>
                  fetch(input, {
                    ...init,
                    signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
                  })
                )
            })
          : { disabled: true }
    });
  } catch (error) {
    return errorResponse(
      error instanceof TeamFunctionError ? error : new TeamFunctionError('VIDEO_R2_PROVIDER_UNAVAILABLE', { retryable: true })
    );
  }
});
