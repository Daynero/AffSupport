// @deno-types="../../../packages/shared/dist/team/catalog-video-r2.d.ts"
import { isCatalogVideoR2PublicUrl } from '../../../packages/shared/dist/team/catalog-video-r2.js';
import type { ServiceRpcClient } from './credentials.ts';
import { TeamFunctionError } from './errors.ts';
import { isRecord } from './validation.ts';

/**
 * The one place that decides which link a catalog cell gets for a video (050, R1).
 *
 * Without the option the answer is whatever the caller's Drive path produces
 * today — the caller keeps that path, byte for byte, behind `drive()`. With the
 * option and a verified ready copy the answer is the opaque public R2 URL, and
 * the Drive file is not touched. With the option and no ready copy the copy is
 * queued and the Drive path is used (FR-006). Nothing here ever throws because
 * R2 is missing; a broken R2 is a reason, not a failed catalog.
 *
 * The returned URL is the base link: the per-row `?v=` variation is applied by
 * the caller afterwards, exactly as for Drive links.
 */
export interface CatalogVideoLinkSource {
  materialId: string;
  sourceVersion: string;
  sizeBytes: number | null;
  mimeType: string | null;
  /** Drive's md5Checksum, when it has one; used only for the full-file proof. */
  checksum: string | null;
}

export type CatalogVideoLink =
  | { kind: 'drive'; url: string }
  | { kind: 'r2'; url: string; copyId: string };

/**
 * Who is asking: an existing catalog, a publication job (the catalog is derived
 * server-side), or a catalog being created right now, whose create request
 * carries the option before any preference row exists.
 */
export type CatalogVideoLinkScope =
  | { catalogMaterialId: string }
  | { publicationJobId: string }
  | { teamId: string; assumeEnabled: boolean };

export interface CatalogVideoLinkInput {
  scope: CatalogVideoLinkScope;
  source: CatalogVideoLinkSource;
  /** The caller's existing Drive path (sharing proof + share link); invoked only for a Drive answer. */
  drive: () => Promise<string>;
}

export interface CatalogVideoLinkResolver {
  resolve(input: CatalogVideoLinkInput): Promise<CatalogVideoLink>;
}

export interface CatalogVideoLinkDeps {
  service: Pick<ServiceRpcClient, 'rpc'>;
  /** Best-effort nudge for the copy worker after a copy was just planned. */
  kick?: () => Promise<void>;
  log?: (message: string, detail?: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createCatalogVideoLinkResolver(deps: CatalogVideoLinkDeps): CatalogVideoLinkResolver {
  return {
    async resolve(input) {
      const scope = input.scope;
      const scopeId =
        'catalogMaterialId' in scope
          ? scope.catalogMaterialId
          : 'publicationJobId' in scope
            ? scope.publicationJobId
            : scope.teamId;
      if (!UUID.test(scopeId) || !UUID.test(input.source.materialId))
        throw new TeamFunctionError('INVALID_INPUT');
      if ('teamId' in scope && !scope.assumeEnabled) return { kind: 'drive', url: await input.drive() };
      let decision: unknown;
      try {
        const { data, error } = await deps.service.rpc('service_catalog_video_r2_resolve', {
          p_catalog: 'catalogMaterialId' in scope ? scope.catalogMaterialId : null,
          p_source_material: input.source.materialId,
          p_source_version: input.source.sourceVersion,
          p_size_bytes: input.source.sizeBytes,
          p_mime: input.source.mimeType,
          p_md5: input.source.checksum,
          p_job: 'publicationJobId' in scope ? scope.publicationJobId : null,
          p_team: 'teamId' in scope ? scope.teamId : null,
          p_assume_enabled: 'teamId' in scope ? scope.assumeEnabled : false
        });
        if (error) throw error;
        decision = data;
      } catch (error) {
        deps.log?.(
          '[catalog-video-link] resolve failed, using Drive',
          error instanceof Error ? error.message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ?? 'UNKNOWN' : 'UNKNOWN'
        );
        return { kind: 'drive', url: await input.drive() };
      }
      if (!isRecord(decision) || decision.enabled !== true) return { kind: 'drive', url: await input.drive() };
      if (
        typeof decision.url === 'string' &&
        typeof decision.copyId === 'string' &&
        UUID.test(decision.copyId) &&
        decision.state === 'ready' &&
        isCatalogVideoR2PublicUrl(decision.url)
      )
        return { kind: 'r2', url: decision.url, copyId: decision.copyId };
      if (decision.state === 'planned' && deps.kick) await deps.kick().catch(() => undefined);
      return { kind: 'drive', url: await input.drive() };
    }
  };
}
