import { classifyCatalogImageName, isCatalogImageGrant } from '@video-compressor/shared';
import type { Json } from '../lib/database.types';
import { requireSupabaseClient } from '../lib/supabase';
import { invokeTeamFunction, TeamApiError } from './team';
import { uploadCatalogImage } from './team-catalog-images';

/**
 * The shared white image pool (052) as the platform owner sees it: what is in it,
 * which spaces use it before it is switched on for everyone, and a folder upload that
 * speaks the same durable protocol as scripts/catalog-global-operator.mjs.
 */
export interface GlobalPoolOverview {
  policy: {
    state: string;
    environment: string | null;
    mediaOrigin: string | null;
    routingRevision: string;
    acceptedKeyVersions: number[];
    servingVerifiedAt: string | null;
    activatedAt: string | null;
  };
  images: {
    total: number;
    ready: number;
    pending: number;
    failed: number;
    hidden: number;
    uses: number;
  };
  pilot: Array<{ teamId: string; name: string; addedAt: string }>;
  jobs: Array<{
    id: string;
    state: string;
    totalFiles: number;
    createdAt: string;
    ready: number;
    failed: number;
    waiting: number;
  }>;
}
export interface GlobalPoolImage {
  id: string;
  garment: string | null;
  color: string | null;
  state: string;
  active: boolean;
  uses: number;
  createdAt: string;
  name: string | null;
  url: string | null;
}
export interface GlobalPoolTeam {
  teamId: string;
  name: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

async function pool<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await requireSupabaseClient().rpc('admin_catalog_global_pool', {
    p_action: action,
    p_payload: payload as Json
  });
  if (error) {
    const code = /PERMISSION_DENIED|NOT_FOUND|INVALID_INPUT|GLOBAL_IMAGE_[A-Z_]+/u.exec(
      error.message
    )?.[0];
    throw new TeamApiError((code ?? 'INVALID_RESPONSE') as never, false);
  }
  if (!isObject(data)) throw new TeamApiError('INVALID_RESPONSE', false);
  return data as T;
}

export const globalPool = {
  overview: () => pool<GlobalPoolOverview>('overview'),
  images: (input: { offset: number; limit: number; garment?: string; color?: string }) =>
    pool<{ images: GlobalPoolImage[]; total: number }>('images', input),
  setVisible: (imageId: string, visible: boolean) =>
    pool<{ active: boolean }>(visible ? 'show' : 'hide', { imageId }),
  teams: (query: string) => pool<{ teams: GlobalPoolTeam[] }>('teams', query ? { query } : {}),
  addPilot: (teamId: string) => pool<GlobalPoolOverview>('pilot_add', { teamId }),
  removePilot: (teamId: string) => pool<GlobalPoolOverview>('pilot_remove', { teamId }),
  configure: (input: {
    environment: 'dev' | 'beta' | 'production';
    mediaOrigin: string;
    routingRevision: string;
    acceptedKeyVersions: number[];
  }) => pool<GlobalPoolOverview>('configure', input)
};

interface ImportEntry {
  id: string;
  fileKey: string;
  state: string;
}
interface ImportJob {
  id: string;
  state: string;
  entries: ImportEntry[];
  hasMore: boolean;
  nextCursor: string | null;
}
const isImportJob = (value: unknown): value is ImportJob =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.state === 'string' &&
  Array.isArray(value.entries);

const control = <T>(
  action: string,
  payload: Record<string, unknown>,
  guard: (v: unknown) => v is T
) => invokeTeamFunction('catalog-global-images/control', { action, payload }, guard);

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const POOL_IMAGE_PATTERN = /\.(?:jpe?g|png|webp)$/iu;
export const POOL_IMPORT_MAX_FILES = 1000;

export interface PoolImportProgress {
  total: number;
  uploaded: number;
  skipped: number;
}

/**
 * Upload a chosen folder into the pool. The request key is derived from the folder's
 * names and sizes, so choosing the same folder again resumes the same durable job
 * instead of starting a second one. Upload is a hint: the background worker still
 * validates, publishes and proves every image before it can be drawn.
 */
export async function importPoolImages(
  chosen: File[],
  input: { signal: AbortSignal; onProgress: (progress: PoolImportProgress) => void }
): Promise<{ jobId: string; uploaded: number }> {
  const byName = new Map<string, File>();
  for (const file of chosen)
    if (POOL_IMAGE_PATTERN.test(file.name) && !byName.has(file.name)) byName.set(file.name, file);
  const files = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length || files.length > POOL_IMPORT_MAX_FILES)
    throw new TeamApiError('INVALID_INPUT', false);
  const manifest = await Promise.all(
    files.map(async file => ({
      fileKey: await sha256Hex(file.name),
      displayName: file.name,
      size: file.size,
      mime: /\.png$/iu.test(file.name)
        ? 'image/png'
        : /\.webp$/iu.test(file.name)
          ? 'image/webp'
          : 'image/jpeg',
      classification: classifyCatalogImageName(file.name)
    }))
  );
  const key = `web:${(await sha256Hex(manifest.map(m => `${m.displayName}:${m.size}`).join('\n'))).slice(0, 48)}`;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const job = await control(
    'begin',
    { idempotencyKey: key, totalFiles: files.length, totalBytes: String(totalBytes) },
    isImportJob
  );
  if (job.state === 'collecting') {
    for (let n = 0; n < manifest.length; n += 100)
      await control(
        'manifest',
        { jobId: job.id, pageKey: `page-${n / 100}`, entries: manifest.slice(n, n + 100) },
        isObject
      );
    await control('seal', { jobId: job.id }, isObject);
  }
  const fileByKey = new Map(manifest.map((entry, index) => [entry.fileKey, files[index]!]));
  const waiting: ImportEntry[] = [];
  let cursor: string | null = null;
  do {
    const page: ImportJob = await control('get', { jobId: job.id, cursor }, isImportJob);
    waiting.push(...page.entries.filter(entry => entry.state === 'waiting_source'));
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  const progress = { total: files.length, uploaded: 0, skipped: files.length - waiting.length };
  input.onProgress({ ...progress });
  const queue = [...waiting];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const file = fileByKey.get(entry.fileKey);
      if (!file) throw new TeamApiError('IMAGE_SOURCE_CHANGED' as never, false);
      const grant = await withCapacity(() =>
        control(
          'grant',
          { jobId: job.id, entryId: entry.id, requestKey: `${key}:${entry.id}` },
          isCatalogImageGrant
        )
      );
      await uploadCatalogImage(grant, file, { signal: input.signal, onProgress: () => {} });
      await control('delivered', { jobId: job.id, entryId: entry.id }, isObject);
      progress.uploaded++;
      input.onProgress({ ...progress });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { jobId: job.id, uploaded: progress.uploaded };
}

/** Only a definite staging-capacity refusal waits; anything else is the caller's. */
async function withCapacity<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof TeamApiError) ||
        error.code !== ('IMAGE_UPLOAD_CAPACITY_BUSY' as never) ||
        attempt >= 30
      )
        throw error;
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(2000, 250 * 2 ** Math.min(attempt, 3)))
      );
    }
  }
}
