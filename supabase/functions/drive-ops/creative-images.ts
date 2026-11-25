import type { ServiceRpcClient } from '../_shared/credentials.ts';
import type { DriveFileMetadata } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { driveImageLink } from '../_shared/product-catalog.ts';
import { verifyAnonymousImage } from '../_shared/catalog-image-sharing.ts';
import { optimizeCatalogImage } from '../_shared/catalog-image-optimization.ts';
import type { CatalogImageR2 } from '../_shared/r2-catalog-images.ts';
import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';
import type { CreativeImageStage } from '../../../packages/shared/dist/team/launches.js';
import type {
  CatalogCreativeImageLink,
  CatalogVideo,
  ProductCatalogDeps
} from './product-catalog.ts';

/**
 * 062 (R7, R29, R33): the public link of a Launch's image creative.
 *
 * With the catalog's R2 option on, the picture is read from Drive with proof, made canonical
 * by the same optimizer as the white pool, written once under `c1/<uuid>` in the public image
 * bucket and read back anonymously byte for byte before it is committed. A version of a file
 * already published is reused (the reservation is keyed by its Drive version and checksum).
 * With the option off, the link is Drive's own picture link, shared by the caller and read
 * anonymously here. Either way nothing is returned that a signed-out reader cannot fetch.
 */
export interface CreativeImagePublisherDeps {
  service: ServiceRpcClient;
  r2: CatalogImageR2 | null;
  readMaterial(
    team: string,
    actor: string,
    material: string,
    expected: {
      fileId: string;
      resourceKey: string | null;
      version: string | null;
      checksum: string | null;
      size: number | null;
    },
    signal: AbortSignal
  ): Promise<Uint8Array>;
  optimize?: typeof optimizeCatalogImage;
  verifyAnonymous?: typeof verifyAnonymousImage;
  /** Per image; the function's own wall clock bounds the whole catalog. */
  timeoutMs?: number;
}

const OBJECT_KEY = /^c1\/[0-9a-f-]{36}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Drive's limit for one creative; the optimizer brings it under 8 MB or refuses it. */
const SOURCE_MAX_BYTES = 50_000_000;
const FORMAT_CODES = new Set([
  'IMAGE_DIMENSIONS_INVALID',
  'IMAGE_UNSUPPORTED_FORMAT',
  'IMAGE_CONTENT_INVALID',
  'IMAGE_ANIMATED_UNSUPPORTED',
  'IMAGE_ORIENTATION_UNSUPPORTED'
]);

async function rpc(
  service: ServiceRpcClient,
  name: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await service.rpc(name, params);
  if (error)
    throw new TeamFunctionError(
      TEAM_ERROR_CODES.find(code => code === error.message) ?? 'PROCESS_RESULT_UNCERTAIN',
      { retryable: true }
    );
  return data;
}

/** The reservation's answer: an already published version, or a key to publish under. */
export function parseCreativeImageReservation(
  value: unknown
):
  | { state: 'ready'; id: string; url: string }
  | { state: 'reserved'; id: string; objectKey: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || !UUID.test(value.id))
    throw new TeamFunctionError('INVALID_RESPONSE');
  if (
    value.state === 'ready' &&
    typeof value.url === 'string' &&
    /^https:\/\/[^\s?#]+$/u.test(value.url)
  )
    return { state: 'ready', id: value.id, url: value.url };
  if (
    value.state === 'reserved' &&
    typeof value.objectKey === 'string' &&
    OBJECT_KEY.test(value.objectKey)
  )
    return { state: 'reserved', id: value.id, objectKey: value.objectKey };
  throw new TeamFunctionError('INVALID_RESPONSE');
}

/** A picture the optimizer refused, in the creative's own words. */
function creativeImageFailure(error: unknown): TeamFunctionError | null {
  if (!(error instanceof TeamFunctionError)) return null;
  if (error.code === 'IMAGE_TOO_LARGE' || error.code === 'TOO_LARGE')
    return new TeamFunctionError('CREATIVE_IMAGE_TOO_LARGE', { retryable: false });
  if (FORMAT_CODES.has(error.code))
    return new TeamFunctionError('CREATIVE_IMAGE_FORMAT', { retryable: false });
  return null;
}

export function createCreativeImagePublisher(
  deps: CreativeImagePublisherDeps
): NonNullable<ProductCatalogDeps['publishCreativeImages']> {
  const optimize = deps.optimize ?? optimizeCatalogImage;
  const verifyAnonymous = deps.verifyAnonymous ?? verifyAnonymousImage;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  type Observe = (stage: CreativeImageStage, attemptId: string | null) => Promise<void>;
  const publishDrive = async (
    image: { ordinal: number; material: CatalogVideo; live: DriveFileMetadata },
    signal: AbortSignal,
    observe: Observe
  ): Promise<CatalogCreativeImageLink> => {
    const link = driveImageLink(
      image.live.id,
      image.live.resourceKey ?? image.material.resourceKey
    );
    // The caller has shared the file: the link exists, a signed-out read proves it.
    await observe('creative_image.accepted', null);
    await observe('creative_image.published', null);
    await verifyAnonymous(link, { signal });
    await observe('creative_image.verified', null);
    return { ordinal: image.ordinal, link, linkKind: 'drive' };
  };

  const publishR2 = async (
    teamId: string,
    actorId: string,
    image: { ordinal: number; material: CatalogVideo; live: DriveFileMetadata },
    signal: AbortSignal,
    observe: Observe
  ): Promise<CatalogCreativeImageLink> => {
    const r2 = deps.r2;
    if (!r2) throw new TeamFunctionError('IMAGE_PROVIDER_UNAVAILABLE', { retryable: true });
    const { live, material } = image;
    if (!live.version || !live.checksum || !/^[0-9a-f]{32}$/iu.test(live.checksum))
      throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
    if (live.size !== null && live.size > SOURCE_MAX_BYTES)
      throw new TeamFunctionError('CREATIVE_IMAGE_TOO_LARGE', { retryable: false });
    const attempt = crypto.randomUUID();
    const reservation = parseCreativeImageReservation(
      await rpc(deps.service, 'service_reserve_launch_creative_image', {
        p_team: teamId,
        p_material: material.id,
        p_version: live.version,
        p_checksum: live.checksum.toLowerCase(),
        p_attempt: attempt
      })
    );
    await observe('creative_image.accepted', attempt);
    if (reservation.state === 'ready') {
      // A version published for an earlier catalog is reused, but only once a signed-out
      // reader still gets it.
      await observe('creative_image.published', attempt);
      await verifyAnonymous(reservation.url, { signal });
      await observe('creative_image.verified', attempt);
      return {
        ordinal: image.ordinal,
        link: reservation.url,
        linkKind: 'r2',
        imageId: reservation.id
      };
    }
    const fail = async (code: string) =>
      rpc(deps.service, 'service_fail_launch_creative_image', {
        p_id: reservation.id,
        p_attempt: attempt,
        p_code: code
      }).catch(() => undefined);
    let optimized: Awaited<ReturnType<typeof optimizeCatalogImage>>;
    try {
      const bytes = await deps.readMaterial(
        teamId,
        actorId,
        material.id,
        {
          fileId: live.id,
          resourceKey: live.resourceKey ?? material.resourceKey,
          version: live.version,
          checksum: live.checksum,
          size: live.size
        },
        signal
      );
      // A creative is keyed by its Drive version, not by its bytes: a PNG that already fits
      // keeps its compressed raster (checked row by row), only its metadata goes (073).
      optimized = await optimize(bytes, live.mimeType, signal, { recompress: 'when-too-large' });
    } catch (error) {
      const refused = creativeImageFailure(error);
      if (refused) {
        await fail(refused.code);
        throw refused;
      }
      if (error instanceof TeamFunctionError && error.code === 'IMAGE_SOURCE_CHANGED')
        throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
      throw error;
    }
    const mime = optimized.image.mime;
    if (mime !== 'image/jpeg' && mime !== 'image/png') {
      await fail('CREATIVE_IMAGE_FORMAT');
      throw new TeamFunctionError('CREATIVE_IMAGE_FORMAT', { retryable: false });
    }
    // Immutable and create-only: a repeated attempt finds its own object and verifies it.
    await r2.putFinal(reservation.objectKey, optimized.bytes, mime, signal, optimized.image.sha256);
    await observe('creative_image.published', attempt);
    try {
      await r2.verify(reservation.objectKey, optimized.bytes, mime, signal, true);
    } catch {
      throw new TeamFunctionError('PUBLIC_READ_UNVERIFIED', { retryable: true });
    }
    const url = r2.publicUrl(reservation.objectKey);
    const committed = await rpc(deps.service, 'service_commit_launch_creative_image', {
      p_id: reservation.id,
      p_attempt: attempt,
      p_url: url,
      p_mime: mime,
      p_size: optimized.bytes.byteLength
    });
    if (isRecord(committed) && committed.url !== undefined && committed.url !== url)
      throw new TeamFunctionError('INVALID_RESPONSE');
    await observe('creative_image.verified', attempt);
    return { ordinal: image.ordinal, link: url, linkKind: 'r2', imageId: reservation.id };
  };

  return async ({ teamId, actorId, copyToR2, images, observe }) => {
    const links: CatalogCreativeImageLink[] = [];
    // One at a time: each is a bounded read, optimize and write, and the caller
    // checkpoints after every one, so a restart resumes at the next image.
    for (const image of images) {
      const signal = AbortSignal.timeout(timeoutMs);
      // Diagnostics never decide the publication: a lost stage record is not a failure.
      const stage: Observe = async (value, attemptId) => {
        await observe?.({ ordinal: image.ordinal, stage: value, attemptId }).catch(() => undefined);
      };
      links.push(
        copyToR2
          ? await publishR2(teamId, actorId, image, signal, stage)
          : await publishDrive(image, signal, stage)
      );
    }
    return links;
  };
}
