/**
 * Moving a space's old re-stitch pictures out of the server bucket into the space (030, US5).
 *
 * A space saved before Drive pools names pictures of one computer's library, published to a
 * bucket this release closed to writes. The owner can pick new sources from the space; or,
 * with this, keep the old pictures: each is read from the bucket (reading stays open until the
 * approved deletion), uploaded into `Re-stitch images/<slot>` of the connected Drive through
 * the ordinary upload relay, and the slot's pool gains that folder. Nothing is written to the
 * bucket, and a picture the bucket no longer has is counted, not invented.
 */

import type {
  ImageSlot,
  RestitchSourceInput,
  TeamRestitchDefaults
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { uploadTeamFile } from '../catalog/material-actions-client';
import { downloadLegacyRestitchImage } from './images';

export const LEGACY_TRANSFER_FOLDER = 'Re-stitch images';

export interface LegacyTransferDeps {
  sourceUserId: (teamId: string) => Promise<string>;
  download: typeof downloadLegacyRestitchImage;
  ensureFolder: (
    teamId: string,
    name: string,
    parentMaterialId: string | null
  ) => Promise<{ folderId: string; materialId: string }>;
  upload: (input: { teamId: string; destinationFolderId: string; file: File }) => Promise<unknown>;
  listSources: typeof teamApi.listRestitchSources;
  setSources: (
    teamId: string,
    slot: ImageSlot,
    items: readonly RestitchSourceInput[]
  ) => Promise<unknown>;
}

const defaultDeps: LegacyTransferDeps = {
  sourceUserId: async teamId => (await teamApi.getMemberRestitchPreference(teamId)).sourceUserId,
  download: downloadLegacyRestitchImage,
  ensureFolder: async (teamId, name, parentMaterialId) => {
    const folder = await teamApi.ensureUploadFolder(teamId, { name, parentMaterialId });
    return { folderId: folder.folderId, materialId: folder.materialId };
  },
  upload: input =>
    uploadTeamFile({
      teamId: input.teamId,
      destinationFolderId: input.destinationFolderId,
      file: input.file,
      conflictMode: 'keep_both',
      replaceMaterialId: null,
      versionOfMaterialId: null
    }),
  listSources: (teamId, scope) => teamApi.listRestitchSources(teamId, scope),
  setSources: (teamId, slot, items) => teamApi.setRestitchSources(teamId, slot, items)
};

export interface LegacyTransferReport {
  moved: number;
  /** Ids the settings still named but the bucket no longer had. */
  missing: number;
}

/** What a kept source is referenced by, so the slot keeps what it already had. */
function referenceOf(source: {
  materialId: string | null;
  driveFileId: string | null;
}): RestitchSourceInput | null {
  if (source.materialId) return { materialId: source.materialId };
  if (source.driveFileId) return { driveFileId: source.driveFileId, kind: 'folder' };
  return null;
}

export async function transferLegacyRestitchImages(
  teamId: string,
  defaults: TeamRestitchDefaults,
  onProgress: (done: number, total: number) => void = () => {},
  deps: LegacyTransferDeps = defaultDeps
): Promise<LegacyTransferReport> {
  const named: Array<{ slot: ImageSlot; ids: string[] }> = [
    { slot: 'start', ids: defaults.startImageIds },
    { slot: 'end', ids: defaults.endImageIds }
  ];
  const slots = named.filter(entry => entry.ids.length > 0);
  const total = slots.reduce((sum, entry) => sum + entry.ids.length, 0);
  const report: LegacyTransferReport = { moved: 0, missing: 0 };
  if (total === 0) return report;

  const sourceUserId = await deps.sourceUserId(teamId);
  const parent = await deps.ensureFolder(teamId, LEGACY_TRANSFER_FOLDER, null);
  let done = 0;
  for (const { slot, ids } of slots) {
    const folder = await deps.ensureFolder(teamId, slot, parent.materialId);
    for (const id of ids) {
      const found = await deps.download(teamId, sourceUserId, slot, id);
      if (found) {
        const mime =
          found.extension === '.png'
            ? 'image/png'
            : found.extension === '.webp'
              ? 'image/webp'
              : 'image/jpeg';
        await deps.upload({
          teamId,
          destinationFolderId: folder.folderId,
          file: new File([found.blob], `${id}${found.extension}`, { type: mime })
        });
        report.moved += 1;
      } else {
        report.missing += 1;
      }
      done += 1;
      onProgress(done, total);
    }
    // The slot keeps what it had and gains the folder; this is the save that flips the space
    // to Drive mode.
    const current = (await deps.listSources(teamId, 'owner')).pools[slot].sources
      .map(referenceOf)
      .filter((entry): entry is RestitchSourceInput => entry !== null)
      .filter(entry => !('materialId' in entry && entry.materialId === folder.materialId));
    await deps.setSources(teamId, slot, [...current, { materialId: folder.materialId }]);
  }
  return report;
}
