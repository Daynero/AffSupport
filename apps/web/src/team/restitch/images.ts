import type { ImageSlot, TeamRestitchDefaults } from '@video-compressor/shared';
import { requireSupabaseClient } from '../../lib/supabase';
import { importTeamRestitchImage } from '../../api/client';
import { teamApi } from '../../api/team';
import { fetchCompressorState } from '../../stitcher/api';

const BUCKET = 'team-restitch-images';
const EXTENSIONS = ['.png', '.jpg', '.webp'] as const;

function objectPath(
  teamId: string,
  userId: string,
  slot: ImageSlot,
  id: string,
  extension: string
) {
  return `${teamId}/${userId}/${slot}/${id}${extension}`;
}

async function downloadImage(
  teamId: string,
  sourceUserId: string,
  slot: ImageSlot,
  id: string
): Promise<{ blob: Blob; extension: string } | null> {
  const bucket = requireSupabaseClient().storage.from(BUCKET);
  for (const extension of EXTENSIONS) {
    const { data, error } = await bucket.download(
      objectPath(teamId, sourceUserId, slot, id, extension)
    );
    if (!error && data) return { blob: data, extension };
  }
  return null;
}

/**
 * Bring the legacy team images to this paired app with their stable IDs before processing.
 *
 * Only for spaces still in `legacy` source mode (030): their settings name ids of the owner's
 * library, published to the bucket before this release. Nothing is published any more — the
 * uploader is gone with its INSERT policy — and this reader goes when the last space moves.
 */
export async function ensureRestitchImages(
  teamId: string,
  defaults: TeamRestitchDefaults
): Promise<void> {
  if (defaults.operation === 'unstitch') return;
  const preference = await teamApi.getMemberRestitchPreference(teamId);
  const state = await fetchCompressorState();
  const embedding = state.settings.imageEmbedding;
  const needs: Array<{ slot: ImageSlot; id: string }> = [
    ...defaults.startImageIds
      .filter(id => !embedding.startImages.some(asset => asset.id === id))
      .map(id => ({ slot: 'start' as const, id })),
    ...defaults.endImageIds
      .filter(id => !embedding.endImages.some(asset => asset.id === id))
      .map(id => ({ slot: 'end' as const, id }))
  ];
  for (const { slot, id } of needs) {
    const downloaded = await downloadImage(teamId, preference.sourceUserId, slot, id);
    if (!downloaded) throw new Error('RESTITCH_IMAGE_UNAVAILABLE');
    const mime =
      downloaded.extension === '.png'
        ? 'image/png'
        : downloaded.extension === '.webp'
          ? 'image/webp'
          : 'image/jpeg';
    const file = new File([downloaded.blob], `${id}${downloaded.extension}`, { type: mime });
    await importTeamRestitchImage(slot, id, file);
  }
}
