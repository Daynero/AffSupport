import {
  isCatalogImageCapabilities,
  isCatalogImageImportJob,
  isCatalogImageImportList,
  isCatalogImageGrant,
  isCatalogImageDictionaryPage,
  isCatalogImageInventory,
  type CatalogImageCapabilities,
  type CatalogImageImportJob,
  type CatalogImageImportList,
  type CatalogImageGrant,
  type CatalogImageDictionaryPage,
  type CatalogImageInventory
} from '@video-compressor/shared';
import { invokeTeamFunction, TeamApiError } from './team';

export interface CatalogImageManifestFile {
  clientFileKey: string;
  name: string;
  declaredSize: number;
  declaredMime: string;
}

export interface CatalogImageClient {
  continueImport(id: string, input: { idempotencyKey: string }): Promise<CatalogImageImportJob>;
  capabilities(teamId: string): Promise<CatalogImageCapabilities>;
  listImports(teamId: string, cursor?: string | null): Promise<CatalogImageImportList>;
  beginImport(input: {
    teamId: string;
    sourceKind: 'local' | 'drive';
    idempotencyKey: string;
    sourceMaterialIds?: string[];
  }): Promise<CatalogImageImportJob>;
  appendManifest(
    id: string,
    input: { pageKey: string; entries: CatalogImageManifestFile[] }
  ): Promise<CatalogImageImportJob>;
  seal(
    id: string,
    input: { revision: number; manifestCount: number }
  ): Promise<CatalogImageImportJob>;
  grant(
    id: string,
    entryId: string,
    input: { generation: number; requestKey: string }
  ): Promise<CatalogImageGrant>;
  delivered(
    id: string,
    entryId: string,
    input: { grantGeneration: number; requestKey: string }
  ): Promise<CatalogImageImportJob>;
  getImport(id: string, cursor?: string | null): Promise<CatalogImageImportJob>;
  cancel(
    id: string,
    input: { revision: number; idempotencyKey: string }
  ): Promise<CatalogImageImportJob>;
  retry(
    id: string,
    input: { entryIds?: string[]; idempotencyKey: string }
  ): Promise<CatalogImageImportJob>;
  dictionary(teamId: string, cursor?: string | null): Promise<CatalogImageDictionaryPage>;
  inventory(teamId: string): Promise<CatalogImageInventory>;
  remove(
    id: string,
    input: { revision: number; idempotencyKey: string }
  ): Promise<CatalogImageDictionaryPage>;
  revoke(
    id: string,
    input: { revision: number; idempotencyKey: string }
  ): Promise<CatalogImageDictionaryPage>;
}

const query = (path: string, values: Record<string, string | null | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== null && value !== undefined) params.set(key, value);
  return `catalog-images/${path}?${params.toString()}`;
};
const pathId = (id: string) => encodeURIComponent(id);

/** The existing team function boundary owns auth and error-envelope decoding. */
export const catalogImageClient: CatalogImageClient = {
  continueImport: (id, input) =>
    invokeTeamFunction(
      `catalog-images/imports/${pathId(id)}/continue`,
      { ...input },
      isCatalogImageImportJob
    ),
  capabilities: teamId =>
    invokeTeamFunction(query('capabilities', { teamId }), {}, isCatalogImageCapabilities, {
      method: 'GET'
    }),
  listImports: (teamId, cursor) =>
    invokeTeamFunction(query('imports', { teamId, cursor }), {}, isCatalogImageImportList, {
      method: 'GET'
    }),
  beginImport: input =>
    invokeTeamFunction(
      'catalog-images/imports',
      { ...input, contractVersion: 2 },
      isCatalogImageImportJob
    ),
  appendManifest: (id, input) =>
    invokeTeamFunction(
      `catalog-images/imports/${pathId(id)}/manifest`,
      { ...input },
      isCatalogImageImportJob
    ),
  seal: (id, input) =>
    invokeTeamFunction(
      `catalog-images/imports/${pathId(id)}/seal`,
      { ...input },
      isCatalogImageImportJob
    ),
  grant: (id, entryId, input) =>
    invokeTeamFunction(
      `catalog-images/imports/${pathId(id)}/entries/${pathId(entryId)}/grant`,
      { ...input },
      isCatalogImageGrant
    ),
  delivered: (id, entryId, input) =>
    invokeTeamFunction(
      `catalog-images/imports/${pathId(id)}/entries/${pathId(entryId)}/delivered`,
      { ...input },
      isCatalogImageImportJob
    ),
  getImport: (id, cursor) =>
    invokeTeamFunction(query(`imports/${pathId(id)}`, { cursor }), {}, isCatalogImageImportJob, {
      method: 'GET'
    }),
  cancel: (id, input) =>
    invokeTeamFunction(
      `catalog-images/imports/${pathId(id)}/cancel`,
      { ...input },
      isCatalogImageImportJob
    ),
  retry: (id, input) =>
    invokeTeamFunction(
      `catalog-images/imports/${pathId(id)}/retry`,
      { ...input },
      isCatalogImageImportJob
    ),
  dictionary: (teamId, cursor) =>
    invokeTeamFunction(query('dictionary', { teamId, cursor }), {}, isCatalogImageDictionaryPage, {
      method: 'GET'
    }),
  inventory: teamId =>
    invokeTeamFunction(query('inventory', { teamId }), {}, isCatalogImageInventory, {
      method: 'GET'
    }),
  remove: (id, input) =>
    invokeTeamFunction(
      `catalog-images/pool/${pathId(id)}/remove`,
      { ...input },
      isCatalogImageDictionaryPage
    ),
  revoke: (id, input) =>
    invokeTeamFunction(
      `catalog-images/publications/${pathId(id)}/revoke`,
      { ...input, explicitRevocation: true },
      isCatalogImageDictionaryPage
    )
};

export function uploadCatalogImage(
  grant: CatalogImageGrant,
  file: File,
  input: { signal: AbortSignal; onProgress: (loaded: number) => void }
): Promise<void> {
  // A compromised response must not turn a selected file into an arbitrary-origin upload.
  let url: URL;
  try {
    url = new URL(grant.url);
  } catch {
    return Promise.reject(new TeamApiError('INVALID_RESPONSE', false));
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.r2.cloudflarestorage.com') ||
    url.username ||
    url.password
  ) {
    return Promise.reject(new TeamApiError('INVALID_RESPONSE', false));
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (error?: Error) => {
      input.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    request.open('PUT', grant.url);
    request.withCredentials = false;
    request.timeout = 240_000;
    for (const [name, value] of Object.entries(grant.headers)) {
      if (!['content-type', 'x-amz-checksum-sha256'].includes(name.toLowerCase())) {
        finish(new TeamApiError('INVALID_RESPONSE', false));
        return;
      }
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = event => input.onProgress(Math.min(file.size, event.loaded));
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? finish()
        : finish(new TeamApiError('IMAGE_WRITE_UNCERTAIN', true));
    request.onerror = request.ontimeout = () =>
      finish(new TeamApiError('IMAGE_WRITE_UNCERTAIN', true));
    request.onabort = () => finish(new DOMException('Aborted', 'AbortError'));
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) {
      finish(new DOMException('Aborted', 'AbortError'));
      return;
    }
    request.send(file);
  });
}
