import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import { authorizeCaller, requireNamedWorkerSecret } from '../_shared/auth.ts';
import {
  readDriveCredential,
  refreshGoogleAccessToken,
  type ServiceRpcClient
} from '../_shared/credentials.ts';
import { GoogleDriveClient } from '../_shared/drive.ts';
import { catalogImageObject, catalogImageRpc } from '../_shared/catalog-images.ts';
import { CatalogImageR2, readCatalogR2Config } from '../_shared/r2-catalog-images.ts';
import { TeamFunctionError, errorResponse } from '../_shared/errors.ts';
import { handleCatalogImages } from './handler.ts';
import { runCatalogImageWorker } from './worker.ts';
import { createCatalogImageDriveSources } from './drive-sources.ts';

const environmentValues: Readonly<Record<string, string | undefined>> = {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  GOOGLE_CLIENT_ID: Deno.env.get('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: Deno.env.get('GOOGLE_CLIENT_SECRET'),
  DRIVE_OAUTH_MODE: Deno.env.get('DRIVE_OAUTH_MODE'),
  WISHLY_SITE_URL: Deno.env.get('WISHLY_SITE_URL'),
  CATALOG_IMAGES_ENVIRONMENT: Deno.env.get('CATALOG_IMAGES_ENVIRONMENT'),
  CATALOG_IMAGES_ENABLED: Deno.env.get('CATALOG_IMAGES_ENABLED'),
  R2_CATALOG_ACCOUNT_ID: Deno.env.get('R2_CATALOG_ACCOUNT_ID'),
  R2_CATALOG_STAGING_BUCKET: Deno.env.get('R2_CATALOG_STAGING_BUCKET'),
  R2_CATALOG_PUBLIC_BUCKET: Deno.env.get('R2_CATALOG_PUBLIC_BUCKET'),
  R2_CATALOG_PUBLIC_ORIGIN: Deno.env.get('R2_CATALOG_PUBLIC_ORIGIN'),
  R2_CATALOG_ZONE_ID: Deno.env.get('R2_CATALOG_ZONE_ID'),
  R2_CATALOG_PURGE_TOKEN: Deno.env.get('R2_CATALOG_PURGE_TOKEN'),
  R2_CATALOG_TARGET_CONFIRMATION: Deno.env.get('R2_CATALOG_TARGET_CONFIRMATION'),
  R2_CATALOG_ACCESS_KEY_ID: Deno.env.get('R2_CATALOG_ACCESS_KEY_ID'),
  R2_CATALOG_SECRET_ACCESS_KEY: Deno.env.get('R2_CATALOG_SECRET_ACCESS_KEY')
};
const env = (key: string) => environmentValues[key];

function service() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new TeamFunctionError('IMAGE_PROVIDER_UNAVAILABLE');
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

function driveSources(client: ServiceRpcClient) {
  const tokens = new Map<string, Promise<string>>();
  const context = async (team: string, actor: string, material: string) => {
    const raw = await catalogImageRpc(client, 'service_get_material_operation_context', {
      p_team: team,
      p_actor: actor,
      p_material: material,
      p_permission: 'download',
      p_allow_trashed: false
    });
    return catalogImageObject(Array.isArray(raw) ? raw[0] : raw);
  };
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
  const drive = async (credential: string, signal: AbortSignal) =>
    new GoogleDriveClient(await token(credential), (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
      })
    );
  return createCatalogImageDriveSources({ context, token, drive });
}

Deno.serve(async request => {
  try {
    const client = service();
    const configured = readCatalogR2Config(env);
    const accessKeyId = env('R2_CATALOG_ACCESS_KEY_ID');
    const secretAccessKey = env('R2_CATALOG_SECRET_ACCESS_KEY');
    const r2 =
      configured && accessKeyId && secretAccessKey
        ? new CatalogImageR2(
            configured,
            new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
          )
        : null;
    const enabled = env('CATALOG_IMAGES_ENABLED') === 'true';
    return await handleCatalogImages(request, {
      service: client,
      enabled,
      r2,
      siteUrl: env('WISHLY_SITE_URL') ?? '',
      authorize: async req => (await authorizeCaller(req, client)).userId,
      authorizeWorker: req => requireNamedWorkerSecret(req),
      runWorker: async () =>
        r2
          ? runCatalogImageWorker({ service: client, r2, enabled, ...driveSources(client) })
          : { disabled: true }
    });
  } catch (error) {
    return errorResponse(
      error instanceof TeamFunctionError
        ? error
        : new TeamFunctionError('IMAGE_PROVIDER_UNAVAILABLE')
    );
  }
});
