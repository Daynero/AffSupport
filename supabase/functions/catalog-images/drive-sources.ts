// @deno-types="../../../packages/shared/dist/team/catalog-images.d.ts"
import { classifyCatalogImageName } from '../../../packages/shared/dist/team/catalog-images.js';
import {
  proveLiveAncestry,
  requireDriveCapability,
  type GoogleDriveClient,
  type DriveFileMetadata
} from '../_shared/drive.ts';
import {
  catalogImageId,
  catalogImageInteger,
  catalogImageObject,
  catalogImageString
} from '../_shared/catalog-images.ts';
import { readCatalogImageBytes } from '../_shared/catalog-image-validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { CatalogDriveEnumeration } from './worker.ts';

/** Narrow read-only seams; production credential refresh and authenticated client stay in index. */
export interface CatalogImageDriveSourcesDeps {
  context(team: string, actor: string, material: string): Promise<Record<string, unknown>>;
  token(credential: string): Promise<string>;
  drive(
    credential: string,
    signal: AbortSignal
  ): Promise<Pick<GoogleDriveClient, 'getFile' | 'listChildren'>>;
  fetchMedia?: typeof fetch;
}

export function createCatalogImageDriveSources(dependencies: CatalogImageDriveSourcesDeps) {
  const { context, token, drive, fetchMedia = fetch } = dependencies;
  const rootContext = async (
    team: string,
    actor: string,
    material: string,
    signal: AbortSignal
  ) => {
    const row = await context(team, actor, material);
    const rootId = catalogImageString(row.root_folder_id, 1024);
    const credentialId = catalogImageId(row.credential_id);
    const instance = await drive(credentialId, signal);
    return { row, rootId, credentialId, instance };
  };
  return {
    async readDrive(
      source: Record<string, unknown>,
      actor: string,
      team: string,
      signal: AbortSignal
    ): Promise<Uint8Array> {
      const rootMaterial = catalogImageId(source.rootMaterialId);
      const current = await rootContext(team, actor, rootMaterial, signal);
      if (current.rootId !== source.rootId || current.credentialId !== source.credentialId)
        throw new TeamFunctionError('IMAGE_SOURCE_CHANGED');
      const fileId = catalogImageString(source.fileId, 1024);
      const before = await proveLiveAncestry({
        client: current.instance,
        fileId,
        rootFolderId: current.rootId
      });
      requireDriveCapability(before, 'canDownload');
      requireDriveCapability(before, 'canShare');
      if (
        before.version !== source.version ||
        before.checksum !== source.checksum ||
        before.size !== source.size ||
        before.trashed
      )
        throw new TeamFunctionError('IMAGE_SOURCE_CHANGED');
      const url = new URL(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
      );
      url.searchParams.set('alt', 'media');
      url.searchParams.set('supportsAllDrives', 'true');
      if (typeof source.resourceKey === 'string')
        url.searchParams.set('resourceKey', source.resourceKey);
      const response = await fetchMedia(url, {
        signal,
        redirect: 'error',
        headers: { authorization: `Bearer ${await token(current.credentialId)}` }
      });
      const bytes = await readCatalogImageBytes(
        response,
        catalogImageInteger(source.size, 50_000_000)
      );
      const afterContext = await context(team, actor, rootMaterial);
      if (
        afterContext.credential_id !== current.credentialId ||
        afterContext.root_folder_id !== current.rootId
      )
        throw new TeamFunctionError('IMAGE_SOURCE_CHANGED');
      const after = await proveLiveAncestry({
        client: current.instance,
        fileId,
        rootFolderId: current.rootId
      });
      requireDriveCapability(after, 'canDownload');
      requireDriveCapability(after, 'canShare');
      if (
        after.version !== before.version ||
        after.checksum !== before.checksum ||
        after.size !== before.size
      )
        throw new TeamFunctionError('IMAGE_SOURCE_CHANGED');
      return bytes;
    },
    async enumerateDrive(
      claim: Record<string, unknown>,
      signal: AbortSignal
    ): Promise<CatalogDriveEnumeration> {
      const team = catalogImageId(claim.teamId);
      const actor = catalogImageId(claim.actorId);
      if (!Array.isArray(claim.cursor) || claim.cursor.length > 1001)
        throw new TeamFunctionError('INVALID_RESPONSE');
      const queue: unknown[] = [...claim.cursor];
      const seen = new Set<string>();
      const first = queue[0];
      if (first && typeof first === 'object' && 'kind' in first && first.kind === 'seen') {
        queue.shift();
        const item = catalogImageObject(first);
        if (
          !Array.isArray(item.ids) ||
          !item.ids.every(x => typeof x === 'string') ||
          item.ids.length > 100000
        )
          throw new TeamFunctionError('INVALID_RESPONSE');
        for (const id of item.ids) seen.add(id);
      }
      let count = catalogImageInteger(claim.admittedCount, 1000);
      let bytes = catalogImageInteger(claim.admittedBytes, 5_000_000_000);
      const entries: Record<string, unknown>[] = [];
      let steps = 0;
      let more = false;
      const admit = (
        file: DriveFileMetadata,
        rootMaterialId: string,
        rootId: string,
        credentialId: string
      ): boolean => {
        if (!file.mimeType.startsWith('image/') || file.trashed || seen.has(file.id)) return true;
        if (!file.size || file.size > 50_000_000) throw new TeamFunctionError('IMAGE_TOO_LARGE');
        if (count >= 1000 || bytes + file.size > 5_000_000_000) return false;
        const name = catalogImageString(file.name);
        entries.push({
          fileId: file.id,
          name,
          size: file.size,
          mime: file.mimeType,
          classification: classifyCatalogImageName(name),
          source: {
            rootMaterialId,
            rootId,
            credentialId,
            fileId: file.id,
            resourceKey: file.resourceKey,
            version: file.version,
            checksum: file.checksum,
            size: file.size
          }
        });
        seen.add(file.id);
        count += 1;
        bytes += file.size;
        return true;
      };
      while (queue.length && entries.length < 100 && steps++ < 8) {
        const raw = queue.shift();
        const node =
          typeof raw === 'string'
            ? { rootMaterialId: catalogImageId(raw) }
            : catalogImageObject(raw);
        const rootMaterial = catalogImageId(node.rootMaterialId);
        const current = await rootContext(team, actor, rootMaterial, signal);
        const fileId =
          typeof node.fileId === 'string'
            ? node.fileId
            : catalogImageString(current.row.drive_file_id, 1024);
        const live = await proveLiveAncestry({
          client: current.instance,
          fileId,
          rootFolderId: current.rootId
        });
        if (live.mimeType !== 'application/vnd.google-apps.folder') {
          // A specifically selected source must have an explicit unsupported outcome;
          // folders may skip unrelated child files while traversing their contents.
          if (!live.mimeType.startsWith('image/'))
            throw new TeamFunctionError('IMAGE_UNSUPPORTED_FORMAT');
          if (!admit(live, rootMaterial, current.rootId, current.credentialId)) {
            queue.unshift(node);
            more = true;
            break;
          }
          continue;
        }
        requireDriveCapability(live, 'canListChildren');
        const page = await current.instance.listChildren({
          parentId: fileId,
          pageToken: typeof node.pageToken === 'string' ? node.pageToken : null,
          driveId: live.driveId
        });
        if (page.incompleteSearch || page.invalidEntries)
          throw new TeamFunctionError('IMAGE_SOURCE_UNAVAILABLE');
        const next = page.files
          .filter(
            file =>
              file.mimeType.startsWith('image/') ||
              file.mimeType === 'application/vnd.google-apps.folder'
          )
          .map(file => ({ rootMaterialId: rootMaterial, fileId: file.id }));
        if (page.nextPageToken)
          next.push({ rootMaterialId: rootMaterial, fileId, ...{ pageToken: page.nextPageToken } });
        queue.unshift(...next);
        if (queue.length > 1000) throw new TeamFunctionError('IMAGE_QUOTA_EXCEEDED');
      }
      if (count >= 1000 && queue.length) more = true;
      return {
        entries,
        cursor: [{ kind: 'seen', ids: [...seen] }, ...queue],
        complete: more || queue.length === 0,
        more
      };
    }
  };
}
