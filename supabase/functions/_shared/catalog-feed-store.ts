import { AwsClient } from 'npm:aws4fetch@1.0.20';
import { CatalogVideoR2, readCatalogVideoR2Config } from './r2-catalog-video.ts';

/**
 * 057: the store of catalog feeds — the public catalog video bucket (`catalog-feed.ts`), with the
 * same configuration and credentials the catalog video worker uses. Null until all of it is set;
 * an R2 space then cannot create or update a feed catalog, and says so retryably.
 */
export function catalogFeedStoreFromEnv(
  env: (key: string) => string | undefined
): CatalogVideoR2 | null {
  const configured = readCatalogVideoR2Config(env);
  const accessKeyId = env('R2_CATALOG_VIDEO_ACCESS_KEY_ID');
  const secretAccessKey = env('R2_CATALOG_VIDEO_SECRET_ACCESS_KEY');
  return configured && accessKeyId && secretAccessKey
    ? new CatalogVideoR2(
        configured,
        new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
      )
    : null;
}
