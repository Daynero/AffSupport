import { recoverCatalogVideoReplacements } from '../drive-ops/catalog-video-replacement.ts';
import { requireDriveOAuthGate } from '../_shared/auth.ts';
import {
  readDriveCredential,
  refreshGoogleAccessToken,
  type ServiceRpcClient
} from '../_shared/credentials.ts';
import { GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { targetedCatalogWriterEnabled } from '../_shared/restitch-native.ts';
import { runCatalogPublicationScheduler } from './publication-authority.ts';
import { createTargetedCatalogPublicationIo } from './publication-io.ts';

/** True when the request asks for the deferred-publication lane only. */
export function isPublicationLaneRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>).publicationsOnly === true
  );
}

type Env = (name: string) => string | undefined;

/**
 * The deferred-publication lane (1.4.3).
 *
 * Called every ten seconds by `private.invoke_catalog_publication_worker`, and at once when a
 * catalog's video set becomes ready, but only while a publication is due. It runs nothing but
 * the existing bounded publication scheduler, so a due link no longer waits for the per-minute
 * catalog-updater pass — which also never ran at all while no other catalog work was due.
 * Fences, leases and idempotency are the scheduler's own; this lane adds none.
 */
export async function runCatalogPublicationLane(
  service: ServiceRpcClient,
  workerId: string,
  env: Env
) {
  const targeted = targetedCatalogWriterEnabled({
    enabled: env('CATALOG_NATIVE_SHEETS_BETA'),
    variants: env('SOTY_CATALOG_VIDEO_VARIANTS'),
    environment: env('SOTY_ENVIRONMENT'),
    oauthMode: env('DRIVE_OAUTH_MODE'),
    siteUrl: env('WISHLY_SITE_URL')
  });
  if (!targeted) return runCatalogPublicationScheduler({ service, workerId, io: null });
  const signals = { siteUrl: env('WISHLY_SITE_URL') };
  const oauthMode = env('DRIVE_OAUTH_MODE');
  requireDriveOAuthGate(signals, oauthMode);
  const clientId = env('GOOGLE_CLIENT_ID');
  const clientSecret = env('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret)
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
  const drives = new Map<string, Promise<GoogleDriveClient>>();
  const driveFor = (credentialId: string): Promise<GoogleDriveClient> => {
    let drive = drives.get(credentialId);
    if (!drive) {
      drive = readDriveCredential(service, credentialId)
        .then(credential =>
          refreshGoogleAccessToken({
            credential,
            clientId,
            clientSecret,
            oauthMode,
            productionSignals: signals
          })
        )
        .then(token => new GoogleDriveClient(token.accessToken));
      drive.catch(() => drives.delete(credentialId));
      drives.set(credentialId, drive);
    }
    return drive;
  };
  const io = createTargetedCatalogPublicationIo(service, workerId, driveFor);
  const result = await runPublicationPasses(() =>
    runCatalogPublicationScheduler({ service, workerId, io })
  );
  await recoverCatalogVideoReplacements({
    service,
    driveFor: async credential =>
      (await driveFor(credential)).withRequestDeadline(Date.now() + 7000)
  });
  return result;
}

/** How many scheduler passes one lane call may chain, and for how long. */
export const PUBLICATION_LANE_PASSES = 3;
export const PUBLICATION_LANE_BUDGET_MS = 8_000;

type PassResult = Awaited<ReturnType<typeof runCatalogPublicationScheduler>>;

/**
 * A due link used to take three ten-second ticks: one turned the policy into a job,
 * the next froze its payload, the third dispatched and verified it (38 s after due on
 * next, 1.4.3). While a pass leaves work it moved but did not finish, the same call
 * runs the next pass at once, within a small budget. Fences and leases are each
 * pass's own; chaining only removes the wait between them.
 */
export async function runPublicationPasses(
  pass: () => Promise<PassResult>,
  clock: () => number = Date.now
): Promise<PassResult> {
  const started = clock();
  let result = await pass();
  for (let done = 1; done < PUBLICATION_LANE_PASSES; done++) {
    if (!result.enabled) break;
    const unsettled = result.claimed - result.verified - result.preserved - result.blocked;
    if (result.prepared <= 0 && unsettled <= 0) break;
    if (clock() - started >= PUBLICATION_LANE_BUDGET_MS) break;
    result = await pass();
  }
  return result;
}
