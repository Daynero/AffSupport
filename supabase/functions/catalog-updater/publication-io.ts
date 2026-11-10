import type { ServiceRpcClient } from '../_shared/credentials.ts';
import type { GoogleDriveClient } from '../_shared/drive.ts';
import { proveLiveAncestry } from '../_shared/drive.ts';
import { catalogPublicationSourceIdentity } from '../../../packages/shared/dist/team/catalog-publication-source.js';
import {
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_CATALOG_SHEET_NAME,
  videoShareLink
} from '../_shared/product-catalog.ts';
import { ensureAnyoneReader } from '../_shared/link-sharing.ts';
import { createCatalogVideoLinkResolver } from '../_shared/catalog-video-link.ts';
// @deno-types="../../../packages/shared/dist/team/catalog-video-r2.d.ts"
import { isCatalogVideoR2PublicUrl } from '../../../packages/shared/dist/team/catalog-video-r2.js';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { CatalogPublicationIo } from './publication-authority.ts';
import {
  applyPublicationCells,
  verifyPublicationCells,
  parseFrozenPublicationCells,
  type FrozenPublicationCells
} from './publication-cells.ts';
const uncertain = () => new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
/** Observe (≈8 provider reads) plus one batchUpdate, with margin. */
const WRITE_BUDGET_MS = 20_000;
const field = (r: Record<string, unknown>, key: string) => {
  const value = r[key];
  if (typeof value !== 'string' || !value) throw uncertain();
  return value;
};
type Scope = Readonly<{ teamId: string; actorId: string; jobId: string }>;
/** Backend-only preparation uses the original job and bounded unique-output
 * receipts. Due validation does no media work and retains original URLs. */
export function createTargetedCatalogPublicationIo(
  service: ServiceRpcClient,
  workerId: string,
  driveFor: (credentialId: string) => Promise<GoogleDriveClient>
): CatalogPublicationIo {
  const deadlineAt = Date.now() + 7_000;
  async function scopedDrive(credential: string) {
    const drive = await driveFor(credential);
    return typeof drive.withRequestDeadline === 'function'
      ? drive.withRequestDeadline(deadlineAt)
      : drive;
  }
  const ancestorCache = new Map<string, ReturnType<GoogleDriveClient['getFile']>>();
  // 050: the one place that decides Drive or R2 for a cell; Drive stays byte for byte.
  const videoLinks = createCatalogVideoLinkResolver({
    service,
    kick: async () => {
      await service.rpc('service_catalog_video_r2_kick', { p_route: 'claim' });
    }
  });
  async function rpc(name: string, args: Record<string, unknown>) {
    const r = await service.rpc(name, args);
    if (r.error) {
      const known = (
        ['SOURCE_CHANGED', 'PERMISSION_DENIED', 'WRONG_STATE', 'NOT_FOUND'] as const
      ).find(code => isRecord(r.error) && r.error.message === code);
      if (known) throw new TeamFunctionError(known);
      throw uncertain();
    }
    return r.data;
  }
  async function context(jobId: string) {
    const c = await rpc('service_catalog_publication_cells_context', {
      p_job: jobId,
      p_worker: workerId
    });
    if (!isRecord(c)) throw uncertain();
    return c;
  }
  function receipts(c: Record<string, unknown>) {
    if (!Array.isArray(c.links)) throw uncertain();
    const links = new Map<string, Record<string, unknown>>();
    for (const receipt of c.links) {
      if (!isRecord(receipt)) throw uncertain();
      links.set(field(receipt, 'materialId'), receipt);
    }
    return links;
  }
  function complete(c: Record<string, unknown>) {
    if (!Array.isArray(c.sources)) return false;
    const links = receipts(c);
    return c.sources.every(
      source =>
        isRecord(source) &&
        (() => {
          const receipt = links.get(field(source, 'materialId'));
          return (
            receipt &&
            receipt.sourceVersion === source.sourceVersion &&
            (c.phase !== 'due' || receipt.dueVerified === true)
          );
        })()
    );
  }
  /** The write and its readback get their own budget: preparation may use the
   * whole tick budget, and a write sent with none left never reaches Google. */
  async function load(jobId: string) {
    const c = await context(jobId);
    if (!complete(c)) throw uncertain();
    const frozen = parseFrozenPublicationCells(c.prepared);
    if (!frozen) throw uncertain();
    const drive = await driveFor(field(c, 'credentialId'));
    const writeDeadline = Date.now() + WRITE_BUDGET_MS;
    return {
      drive:
        typeof drive.withRequestDeadline === 'function'
          ? drive.withRequestDeadline(writeDeadline)
          : drive,
      frozen
    };
  }
  async function prepare(
    scope: Scope,
    allowSharing = true
  ): Promise<'ready' | 'waiting' | 'blocked'> {
    let c = await context(scope.jobId);
    if (c.state === 'waiting') return 'waiting';
    if (c.state === 'blocked') return 'blocked';
    if (!Array.isArray(c.sources) || typeof c.productCount !== 'number') throw uncertain();
    const prior = receipts(c),
      unique = new Map<string, Record<string, unknown>>();
    for (const source of c.sources) {
      if (!isRecord(source)) throw uncertain();
      unique.set(field(source, 'materialId'), source);
    }
    // Small concurrent batches consume the remaining tick budget. Duplicated
    // product assignments never repeat provider work; no per-output timer delay.
    const needed = [...unique]
      .filter(([id, source]) => {
        const old = prior.get(id);
        return !(
          old &&
          old.sourceVersion === source.sourceVersion &&
          (c.phase !== 'due' || old.dueVerified === true)
        );
      })
      .slice(0, 32);
    async function prove([materialId, source]: [string, Record<string, unknown>]) {
      const old = prior.get(materialId);

      const drive = await scopedDrive(field(source, 'credentialId')),
        fileId = field(source, 'fileId');
      const credential = field(source, 'credentialId');
      const live = await proveLiveAncestry({
        client: drive,
        fileId,
        rootFolderId: field(source, 'rootFolderId'),
        maximumDepth: 16,
        readAncestor(id) {
          const key = credential + '|' + id;
          let read = ancestorCache.get(key);
          if (!read) {
            read = drive.getFile(id);
            ancestorCache.set(key, read);
          }
          return read;
        }
      });
      if (
        live.capabilities.canDownload !== true ||
        (await catalogPublicationSourceIdentity(
          {
            materialId,
            connectionId: field(source, 'connectionId'),
            fileId: live.id,
            checksum: live.checksum,
            mimeType: live.mimeType,
            sizeBytes: live.size,
            driveVersion: live.version
          },
          field(source, 'sourceVersion').startsWith('strict-v1:')
        )) !== source.sourceVersion
      )
        throw new TeamFunctionError('SOURCE_CHANGED');
      const link = await videoLinks.resolve({
        scope: { publicationJobId: scope.jobId },
        source: {
          materialId,
          sourceVersion: source.sourceVersion,
          sizeBytes: live.size,
          mimeType: live.mimeType,
          checksum: live.checksum
        },
        drive: async () => {
          const permissions = await drive.listAnyonePermissions(fileId);
          if (permissions.length === 0) {
            if (!allowSharing) throw new TeamFunctionError('PERMISSION_DENIED');
            if (live.capabilities.canShare !== true)
              throw new TeamFunctionError('SHARE_NOT_ALLOWED');
            await ensureAnyoneReader(drive, fileId, permissions);
          }
          return videoShareLink(live.id, live.resourceKey);
        }
      });
      const url = link.url;
      if (old && old.url !== url) throw new TeamFunctionError('SOURCE_CHANGED');
      if (
        (await rpc('service_record_catalog_publication_link', {
          p_job: scope.jobId,
          p_worker: workerId,
          p_material: materialId,
          p_source_version: source.sourceVersion,
          p_url: url,
          p_link_kind: link.kind
        })) !== true
      )
        throw uncertain();
    }
    for (let offset = 0; offset < needed.length && Date.now() < deadlineAt - 1_500; offset += 4) {
      const results = await Promise.allSettled(needed.slice(offset, offset + 4).map(prove));
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failed) throw failed.reason;
    }
    c = await context(scope.jobId);
    if (!complete(c) || Date.now() > deadlineAt - 2_500) return 'waiting';
    if (c.prepared) return 'ready';
    const cached = receipts(c);
    if (!Array.isArray(c.sources) || typeof c.productCount !== 'number') throw uncertain();
    const links = c.sources.map(source => {
      if (!isRecord(source)) throw uncertain();
      const receipt = cached.get(field(source, 'materialId'));
      if (!receipt) throw uncertain();
      return field(receipt, 'url');
    });
    if (c.sourceOnly === true && links.length === 1)
      while (links.length < c.productCount) links.push(links[0]!);
    if (links.length !== c.productCount) throw uncertain();
    const drive = await scopedDrive(field(c, 'credentialId')),
      fileId = field(c, 'fileId');
    await proveLiveAncestry({
      client: drive,
      fileId,
      rootFolderId: field(c, 'rootFolderId'),
      maximumDepth: 16
    });
    const sheet = (await drive.getNativeSpreadsheetSheets(fileId)).find(
      s => s.title === PRODUCT_CATALOG_SHEET_NAME
    );
    if (!sheet) throw new TeamFunctionError('SOURCE_CHANGED');
    const idColumn = PRODUCT_CATALOG_TEMPLATE.findIndex(v => v.source.kind === 'contentId');
    const videoColumn = PRODUCT_CATALOG_TEMPLATE.findIndex(v => v.source.kind === 'videoLink');
    const [ids, videos] = await drive.readNativeCatalogColumns({
      fileId,
      sheetName: PRODUCT_CATALOG_SHEET_NAME,
      columns: [idColumn, videoColumn],
      rowCount: sheet.rowCount,
      expectedRows: c.productCount + 2
    });
    const id = PRODUCT_CATALOG_TEMPLATE[idColumn]!,
      video = PRODUCT_CATALOG_TEMPLATE[videoColumn]!;
    if (
      !ids ||
      !videos ||
      ids[0] !== id.description ||
      ids[1] !== id.key ||
      videos[0] !== video.description ||
      videos[1] !== video.key ||
      new Set(ids.slice(2)).size !== c.productCount ||
      ids.slice(2).some(v => !v)
    )
      throw new TeamFunctionError('SOURCE_CHANGED');
    const frozen: FrozenPublicationCells = {
      fileId,
      rootFolderId: field(c, 'rootFolderId'),
      sheetName: sheet.title,
      sheetId: sheet.sheetId,
      idColumn,
      videoColumn,
      idHeaders: [id.description, id.key],
      videoHeaders: [video.description, video.key],
      products: (Array.isArray(c.publicIds) ? c.publicIds : ids.slice(2)).map((id, index) => {
        if (typeof id !== 'string' || !ids.includes(id))
          throw new TeamFunctionError('SOURCE_CHANGED');
        return { id, url: links[index]! };
      }),
      ...(Array.isArray(c.recipeRowIds) ? { recipeRowIds: c.recipeRowIds as string[] } : {}),
      markerKey: 'soty_video_publication',
      markerValue: scope.jobId,
      ...(typeof c.previousMarker === 'string' ? { previousMarker: c.previousMarker } : {})
    };
    const saved = await rpc('service_prepare_catalog_publication_cells', {
      p_job: scope.jobId,
      p_worker: workerId,
      p_payload: frozen
    });
    if (!parseFrozenPublicationCells(saved)) throw uncertain();
    return 'ready';
  }
  /** After a verified write: which R2 copies this catalog now points at (set-replace, R7). */
  async function confirmVideoUses(jobId: string) {
    const c = await context(jobId);
    if (!Array.isArray(c.sources)) throw uncertain();
    const links = receipts(c);
    const uses: { sourceMaterialId: string; sourceVersion: string }[] = [];
    for (const source of c.sources) {
      if (!isRecord(source)) throw uncertain();
      const receipt = links.get(field(source, 'materialId'));
      if (receipt && isCatalogVideoR2PublicUrl(field(receipt, 'url')))
        uses.push({
          sourceMaterialId: field(source, 'materialId'),
          sourceVersion: field(receipt, 'sourceVersion')
        });
    }
    const confirmed = await service.rpc('service_catalog_video_r2_confirm_use', {
      p_catalog: null,
      p_link_kind: uses.length > 0 ? 'r2' : 'drive',
      p_uses: uses,
      p_job: jobId
    });
    if (confirmed.error)
      throw new TeamFunctionError('VIDEO_R2_CATALOG_WRITE_FAILED', { retryable: true });
  }
  return {
    writerPolicy: 'targeted_video_cells',
    async availability(_item, scope) {
      try {
        return await prepare(scope);
      } catch (cause) {
        const code =
          cause instanceof TeamFunctionError &&
          [
            'SOURCE_CHANGED',
            'PERMISSION_DENIED',
            'SHARE_NOT_ALLOWED',
            'DRIVE_UNAVAILABLE',
            'RATE_LIMITED',
            'INVALID_RESPONSE'
          ].includes(cause.code)
            ? cause.code
            : 'PROCESS_RESULT_UNCERTAIN';
        await rpc('service_release_catalog_publication_preparation', {
          p_job: scope.jobId,
          p_worker: workerId,
          p_error_code: code
        });
        throw cause;
      }
    },
    async preparePending() {
      const pending = await rpc('service_claim_catalog_publication_preparations', {
        p_worker: workerId,
        p_limit: 1
      });
      if (!Array.isArray(pending) || pending.length > 1) throw uncertain();
      for (const scope of pending) {
        if (!isRecord(scope)) throw uncertain();
        const verified = {
          jobId: field(scope, 'jobId'),
          teamId: field(scope, 'teamId'),
          actorId: field(scope, 'actorId')
        };
        let failure: string | null = null;
        try {
          await prepare(verified);
        } catch (cause) {
          failure =
            cause instanceof TeamFunctionError &&
            [
              'SOURCE_CHANGED',
              'PERMISSION_DENIED',
              'SHARE_NOT_ALLOWED',
              'DRIVE_UNAVAILABLE',
              'RATE_LIMITED',
              'INVALID_RESPONSE'
            ].includes(cause.code)
              ? cause.code
              : 'PROCESS_RESULT_UNCERTAIN';
        } finally {
          await rpc('service_release_catalog_publication_preparation', {
            p_job: verified.jobId,
            p_worker: workerId,
            p_error_code: failure
          });
        }
      }
    },
    async apply(_item, fence, scope) {
      if (!scope) throw uncertain();
      const { drive, frozen } = await load(scope.jobId);
      await applyPublicationCells(drive, { ...frozen, markerValue: fence });
    },
    async verify(_item, fence, scope) {
      if (!scope) return { outcome: 'unknown' };
      try {
        if ((await prepare(scope, false)) !== 'ready') return { outcome: 'unknown' };
        const { drive, frozen } = await load(scope.jobId);
        const verified = await verifyPublicationCells(drive, { ...frozen, markerValue: fence });
        if (verified.outcome === 'verified') {
          // A verified write with an unconfirmed R2 use would let the copy retire under the
          // catalog; report unknown so the next verification confirms it (FR-010).
          try {
            await confirmVideoUses(scope.jobId);
          } catch {
            return { outcome: 'unknown' };
          }
        }
        return verified;
      } catch (cause) {
        const code =
          cause instanceof TeamFunctionError &&
          [
            'SOURCE_CHANGED',
            'PERMISSION_DENIED',
            'SHARE_NOT_ALLOWED',
            'DRIVE_UNAVAILABLE',
            'RATE_LIMITED',
            'INVALID_RESPONSE'
          ].includes(cause.code)
            ? cause.code
            : 'PROCESS_RESULT_UNCERTAIN';
        await rpc('service_release_catalog_publication_preparation', {
          p_job: scope.jobId,
          p_worker: workerId,
          p_error_code: code
        });
        return { outcome: 'unknown' };
      }
    }
  };
}
