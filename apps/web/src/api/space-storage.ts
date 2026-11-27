import {
  BUILD_ID,
  SPACE_STORAGE_CAPABILITY,
  SPACE_STORAGE_CAPABILITY_HEADER
} from '@video-compressor/shared';
import type { AppEnvironment } from '@video-compressor/shared';
import type { SiteChannel } from '../lib/config';

/**
 * 057: the web's side of Soty spaces on R2 (the `space-storage` edge function).
 *
 * Every request declares `storage-r2/1`, so the server can tell an old client to update instead
 * of serving it, and names the build for the journal. The client never names a bucket, a key or
 * a storage URL. The transfer routes (uploads, mutations, read grants) join this module with
 * their tasks; creation is called through `teamApi.createR2Space`.
 */
export function spaceStorageRequestHeaders(): Record<string, string> {
  return {
    [SPACE_STORAGE_CAPABILITY_HEADER]: SPACE_STORAGE_CAPABILITY,
    'x-soty-client': `web/${BUILD_ID}`
  };
}

/**
 * Where «On R2» may be offered at all (US11, FR-052/FR-053): on the `next` address to a pilot,
 * never on the production address. Any other address of a non-production stack (beta, a
 * developer's machine) offers it to a pilot too, because the pilot is proven there before it
 * reaches `next`; the Agent's own copy of the production site does not.
 */
export function r2SpaceCreationAvailable(input: {
  channel: SiteChannel;
  environment: AppEnvironment;
  pilot: boolean;
}): boolean {
  if (!input.pilot || input.channel === 'production') return false;
  return input.channel === 'next' || input.environment !== 'production';
}

/**
 * Whether the team lists may show R2 spaces: everywhere except the production address, where
 * the old list keeps them out so an account with a pilot space sees nothing new (FR-053).
 */
export function listsR2Spaces(channel: SiteChannel): boolean {
  return channel !== 'production';
}
