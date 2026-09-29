import type {
  ImageEmbeddingSettings,
  ImageSlot,
  TeamRestitchDefaults
} from '@video-compressor/shared';
import { requireSupabaseClient } from '../../lib/supabase';
import { imageContentUrl, importTeamRestitchImage } from '../../api/client';
import { teamApi } from '../../api/team';
import { fetchCompressorState } from '../../stitcher/api';

const BUCKET = 'team-restitch-images';
const EXTENSIONS = ['.png', '.jpg', '.webp'] as const;

function selected(
  embedding: ImageEmbeddingSettings,
  defaults: Pick<TeamRestitchDefaults, 'startImageIds' | 'endImageIds'>
) {
  return [
    ...embedding.startImages
      .filter(asset => defaults.startImageIds.includes(asset.id))
      .map(asset => ({ slot: 'start' as const, asset })),
    ...embedding.endImages
      .filter(asset => defaults.endImageIds.includes(asset.id))
      .map(asset => ({ slot: 'end' as const, asset }))
  ];
}

function objectPath(
  teamId: string,
  userId: string,
  slot: ImageSlot,
  id: string,
  extension: string
) {
  return `${teamId}/${userId}/${slot}/${id}${extension}`;
}

/** Publish the bytes before saving the settings that refer to them. */
export async function publishRestitchImages(
  teamId: string,
  embedding: ImageEmbeddingSettings,
  defaults: Pick<TeamRestitchDefaults, 'startImageIds' | 'endImageIds'>
): Promise<void> {
  const client = requireSupabaseClient();
  const { data: user, error: userError } = await client.auth.getUser();
  if (userError || !user.user) throw new Error('RESTITCH_IMAGE_UNAVAILABLE');
  const assets = selected(embedding, defaults);
  for (let offset = 0; offset < assets.length; offset += 4) {
    await Promise.all(
      assets.slice(offset, offset + 4).map(async ({ slot, asset }) => {
        const url = await imageContentUrl(asset.id);
        if (!url) throw new Error('RESTITCH_IMAGE_UNAVAILABLE');
        const response = await fetch(url);
        if (!response.ok) throw new Error('RESTITCH_IMAGE_UNAVAILABLE');
        const blob = await response.blob();
        const { error } = await client.storage
          .from(BUCKET)
          .upload(objectPath(teamId, user.user.id, slot, asset.id, asset.extension), blob, {
            contentType: asset.mimeType,
            upsert: false
          });
        // A previously published immutable image is already the right file.
        if (error && error.statusCode !== '409') throw new Error('RESTITCH_IMAGE_UNAVAILABLE');
      })
    );
  }
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

/** Bring selected team images to this paired app with their stable IDs before processing. */
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
