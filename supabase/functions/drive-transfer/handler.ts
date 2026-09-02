import type {
  TeamPreviewResult,
  TeamTransferGrant,
  TeamPreviewUnavailableReason
} from '../../../packages/shared/dist/team/transport.js';
import type { TranscriptIngestState } from '../../../packages/shared/dist/team/contract.js';
import type { MaterialCategory } from '../../../packages/shared/dist/team/material-category.js';
import { TeamFunctionError } from '../_shared/errors.ts';

export const MAX_PREVIEW_RANGE_BYTES = 32 * 1024 * 1024;
export const MAX_BROWSER_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_LANDING_RENDER_SEGMENTS = 64;
const MAX_EDITABLE_TEXT_BYTES = 1024 * 1024;

/**
 * The address of this function as something outside the container can reach it.
 *
 * The edge runtime sees the internal hop, not the public one: `http:` where the function is
 * served over HTTPS, its own port rather than the published one, and a path the gateway has
 * already stripped `/functions/v1` from. Every one of those is wrong for the two readers of
 * this URL — a browser, which blocks mixed content, and the paired app, which refuses a
 * transfer URL that does not name the function it expects.
 *
 * **The local stack needed the port as well, and used to be left alone entirely.** The runtime
 * reports `http://127.0.0.1:8081/drive-transfer/range` there: a port nothing outside the
 * container listens on. The app rejected that out of hand — a team download answered
 * `INVALID_INPUT` in three milliseconds, having never reached the network — which made agent
 * transfers impossible to test anywhere but production.
 *
 * The gateway's `x-forwarded-*` headers carry the address the caller actually used, and they
 * are what repairs it. **They are trusted for loopback and nothing else**: a client can send
 * those headers too, and this URL is handed out with a grant ticket attached, so letting one
 * name an arbitrary host would be handing the ticket to whoever asked. A public request needs
 * no repair beyond the two it already had.
 */
export interface ForwardedOrigin {
  host?: string | null;
  port?: string | null;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function publicEndpointUrl(input: URL, forwarded: ForwardedOrigin = {}): URL {
  const url = new URL(input);
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  if (loopback) {
    const host = forwarded.host?.trim();
    // Host and port are taken together or not at all, and only ever loopback to loopback:
    // a header naming somewhere else is something this function was told, not an address it
    // knows, and the URL it would build carries a grant ticket.
    if (!host || LOOPBACK_HOSTS.includes(host)) {
      if (host) url.hostname = host;
      const port = forwarded.port?.trim();
      if (port && /^\d{1,5}$/u.test(port)) url.port = port;
    }
  } else if (url.protocol === 'http:') {
    url.protocol = 'https:';
  }
  // The gateway routes on this prefix and the app checks for it, so it belongs on every
  // address handed out — the local stack included.
  if (
    !url.pathname.startsWith('/functions/v1/') &&
    (loopback || url.hostname.endsWith('.supabase.co'))
  ) {
    url.pathname = `/functions/v1${url.pathname.startsWith('/') ? '' : '/'}${url.pathname}`;
  }
  return url;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export type LandingArtifactGrantBinding =
  | { mode: 'upload'; renderId: string; operationId: string }
  | { mode: 'view'; renderId: string; segment: number };

export function landingArtifactGrantTool(binding: LandingArtifactGrantBinding): string {
  return binding.mode === 'upload'
    ? `landing-upload:${binding.renderId}:${binding.operationId}`
    : `landing-render:${binding.renderId}:${binding.segment}`;
}

export function parseLandingArtifactGrantTool(value: unknown): LandingArtifactGrantBinding | null {
  if (typeof value !== 'string' || value.length > 240) return null;
  const upload = /^landing-upload:([^:]+):([^:]+)$/u.exec(value);
  if (upload && UUID.test(upload[1]) && UUID.test(upload[2])) {
    return { mode: 'upload', renderId: upload[1], operationId: upload[2] };
  }
  const view = /^landing-render:([^:]+):(\d{1,2})$/u.exec(value);
  if (!view || !UUID.test(view[1])) return null;
  const segment = Number(view[2]);
  return Number.isInteger(segment) && segment >= 0 && segment < MAX_LANDING_RENDER_SEGMENTS
    ? { mode: 'view', renderId: view[1], segment }
    : null;
}

export interface LandingArtifactFolderClient {
  listChildren: (input: { parentId: string }) => Promise<{
    files: Array<{ id: string; name: string; mimeType: string; trashed: boolean }>;
  }>;
  createFolder: (input: { name: string; parentId: string }) => Promise<{ id: string }>;
}

async function ensureFolder(
  client: LandingArtifactFolderClient,
  parentId: string,
  name: string
): Promise<string> {
  const page = await client.listChildren({ parentId });
  const existing = page.files.find(
    file => !file.trashed && file.mimeType === FOLDER_MIME_TYPE && file.name === name
  );
  if (existing) return existing.id;
  return (await client.createFolder({ name, parentId })).id;
}

/** Resolve the hidden, deterministic namespace without exposing any folder id to a caller. */
export async function ensureLandingArtifactFolder(
  client: LandingArtifactFolderClient,
  input: {
    rootFolderId: string;
    materialId: string;
    sourceVersion: string;
    fingerprint: string;
    preset: string;
  }
): Promise<string> {
  if (
    !input.rootFolderId ||
    !UUID.test(input.materialId) ||
    !/^[a-z0-9._-]{1,128}$/iu.test(input.sourceVersion) ||
    !/^[a-f0-9]{64}$/u.test(input.fingerprint) ||
    !/^[a-z0-9_-]{1,64}$/iu.test(input.preset)
  ) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const system = await ensureFolder(client, input.rootFolderId, '.soty');
  const previews = await ensureFolder(client, system, 'landing-previews');
  const material = await ensureFolder(client, previews, input.materialId);
  const source = await ensureFolder(
    client,
    material,
    `${input.sourceVersion}-${input.fingerprint}`
  );
  return ensureFolder(client, source, input.preset);
}

export type PreviewMode = 'media' | 'transcript' | 'archive' | 'landing';

export interface PreviewMaterialRecord {
  teamId: string;
  materialId: string;
  driveFileId: string;
  resourceKey: string | null;
  name: string;
  category: MaterialCategory | null;
  mimeType: string | null;
  fileExtension: string | null;
  sizeBytes: number | null;
  driveVersion: string | null;
  checksum: string | null;
  previewState: string;
  previewErrorCode: string | null;
  transcriptText: string | null;
  transcriptIngestState: TranscriptIngestState;
  transcriptTruncated: boolean;
  transcriptIndexedBytes: number;
  transcriptSourceVersion: string | null;
  canDownload: boolean;
  canEdit: boolean;
}

export type IssuePreviewGrant = (
  material: PreviewMaterialRecord,
  binding: { mode: PreviewMode; operationId: string | null }
) => Promise<TeamTransferGrant>;

export interface PreviewBuildOptions {
  rangeEndpoint?: string;
  operationId?: () => string;
}

export type DownloadGrantResult =
  | {
      kind: 'browser';
      rangeUrl: string;
      expiresAt: string;
      disposition: 'attachment';
    }
  | {
      kind: 'agent';
      transferUrl: string;
      grant: TeamTransferGrant;
    };

export async function buildDownloadGrantResult(
  material: PreviewMaterialRecord,
  options: { consumer: 'browser' | 'agent'; rangeEndpoint: string },
  issueGrant: (material: PreviewMaterialRecord) => Promise<TeamTransferGrant>
): Promise<DownloadGrantResult> {
  if (!material.canDownload) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  if (material.sizeBytes === null || material.sizeBytes < 0) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  if (options.consumer === 'browser' && material.sizeBytes > MAX_BROWSER_DOWNLOAD_BYTES) {
    throw new TeamFunctionError('AGENT_REQUIRED', { retryable: false });
  }
  const endpoint = new URL(options.rangeEndpoint);
  const grant = await issueGrant(material);
  if (grant.purpose !== 'download_range') {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  if (options.consumer === 'agent') {
    return { kind: 'agent', transferUrl: endpoint.toString(), grant };
  }
  endpoint.searchParams.set('grant', grant.ticket);
  return {
    kind: 'browser',
    rangeUrl: endpoint.toString(),
    expiresAt: grant.expiresAt,
    disposition: 'attachment'
  };
}

function unavailableReason(material: PreviewMaterialRecord) {
  const error = material.previewErrorCode?.toLocaleUpperCase('en-US') ?? '';
  if (error.includes('PROTECTED') || error.includes('PASSWORD')) return 'protected' as const;
  if (error.includes('TOO_LARGE') || error.includes('LIMIT')) return 'too_large' as const;
  if (error.includes('CORRUPT') || error.includes('INVALID_ARCHIVE')) return 'corrupt' as const;
  if (material.previewState === 'failed') return 'corrupt' as const;
  return null;
}

function unavailable(
  material: PreviewMaterialRecord,
  reason: TeamPreviewUnavailableReason
): TeamPreviewResult {
  return {
    kind: 'unavailable',
    reason,
    allowedActions: material.canDownload ? ['download'] : []
  };
}

function transcriptActions(material: PreviewMaterialRecord) {
  const actions: Array<'download' | 'edit'> = [];
  if (material.canDownload) actions.push('download');
  if (
    material.canEdit &&
    material.transcriptIngestState === 'full' &&
    !material.transcriptTruncated &&
    material.fileExtension?.toLocaleLowerCase('en-US') === 'txt' &&
    material.sizeBytes !== null &&
    material.sizeBytes <= MAX_EDITABLE_TEXT_BYTES
  ) {
    actions.push('edit');
  }
  return actions;
}

export async function buildPreviewResult(
  material: PreviewMaterialRecord,
  mode: PreviewMode,
  issueGrant: IssuePreviewGrant,
  options: PreviewBuildOptions = {}
): Promise<TeamPreviewResult> {
  const explicitUnavailable = unavailableReason(material);
  if (explicitUnavailable) return unavailable(material, explicitUnavailable);

  if (mode === 'transcript') {
    if (material.category !== 'transcript') return unavailable(material, 'unsupported');
    return {
      kind: 'transcript',
      text:
        material.transcriptIngestState === 'full' || material.transcriptIngestState === 'truncated'
          ? material.transcriptText
          : null,
      ingestState: material.transcriptIngestState,
      truncated: material.transcriptTruncated,
      indexedBytes: material.transcriptIndexedBytes,
      sourceVersion: material.transcriptSourceVersion,
      allowedActions: transcriptActions(material)
    };
  }

  if (mode === 'media') {
    if (material.category !== 'video' && material.category !== 'image') {
      return unavailable(material, 'unsupported');
    }
    if (!material.mimeType) return unavailable(material, 'unsupported');
    const grant = await issueGrant(material, { mode, operationId: null });
    const endpoint = options.rangeEndpoint;
    if (!endpoint) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    const rangeUrl = new URL(endpoint);
    rangeUrl.searchParams.set('grant', grant.ticket);
    return {
      kind: 'media',
      rangeUrl: rangeUrl.toString(),
      mimeType: material.mimeType,
      expiresAt: grant.expiresAt
    };
  }

  const categoryAllowed =
    mode === 'archive'
      ? material.category === 'archive'
      : material.category === 'landing' || material.category === 'archive';
  if (!categoryAllowed) return unavailable(material, 'unsupported');
  try {
    const operationId = options.operationId?.() ?? crypto.randomUUID();
    const grant = await issueGrant(material, { mode, operationId });
    return {
      kind: 'agent',
      operationId,
      transferGrant: grant,
      previewKind: mode
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'AGENT_REQUIRED') {
      return unavailable(material, 'agent_required');
    }
    throw error;
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Parses one RFC 9110 byte range and caps open/no-range requests to 32 MiB. */
export function parseBoundedRange(
  header: string | null,
  totalBytes: number,
  maximumBytes = MAX_PREVIEW_RANGE_BYTES
): ByteRange {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  const cap = Math.min(Math.max(Math.trunc(maximumBytes), 1), MAX_PREVIEW_RANGE_BYTES);
  if (header === null || header.trim() === '') {
    return { start: 0, end: Math.min(totalBytes, cap) - 1 };
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2])) {
    throw new TeamFunctionError('INVALID_INPUT', { status: 416, retryable: false });
  }
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || suffix > cap) {
      throw new TeamFunctionError(suffix > cap ? 'TOO_LARGE' : 'INVALID_INPUT', {
        status: 416,
        retryable: false
      });
    }
    return { start: Math.max(0, totalBytes - suffix), end: totalBytes - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : Math.min(totalBytes - 1, start + cap - 1);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= totalBytes ||
    requestedEnd < start
  ) {
    throw new TeamFunctionError('INVALID_INPUT', { status: 416, retryable: false });
  }
  const end = Math.min(requestedEnd, totalBytes - 1);
  if (end - start + 1 > cap) {
    throw new TeamFunctionError('TOO_LARGE', { status: 416, retryable: false });
  }
  return { start, end };
}

/**
 * `Content-Disposition` with the file's own name. The browser ignores an
 * anchor's `download` attribute for a cross-origin address, so a download
 * without a name here was saved as "range" (011, findings K1). RFC 6266:
 * an ASCII fallback in `filename`, the real name percent-encoded in
 * `filename*`.
 */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  fileName: string | null
): string {
  const name = (fileName ?? '').replace(/[\r\n"\\]/gu, '').trim();
  if (!name) return disposition;
  const ascii = name.replace(/[^\x20-\x7e]/gu, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function forwardedRangeHeaders(
  upstream: Headers,
  mimeType: string,
  disposition: 'inline' | 'attachment',
  fileName: string | null = null
): Headers {
  const headers = new Headers({
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-disposition': contentDisposition(disposition, fileName),
    'content-type': mimeType || 'application/octet-stream',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  });
  for (const name of ['content-length', 'content-range'] as const) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function validateUpstreamRangeResponse(
  status: number,
  headers: Headers,
  requested: ByteRange,
  totalBytes: number
): number {
  const rawLength = headers.get('content-length');
  const contentLength = rawLength && /^\d+$/u.test(rawLength) ? Number(rawLength) : Number.NaN;
  const expectedLength = requested.end - requested.start + 1;
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedLength) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  if (status === 200) {
    if (requested.start !== 0 || requested.end !== totalBytes - 1) {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    }
    return contentLength;
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(headers.get('content-range') ?? '');
  if (
    status !== 206 ||
    !match ||
    Number(match[1]) !== requested.start ||
    Number(match[2]) !== requested.end ||
    Number(match[3]) !== totalBytes
  ) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return contentLength;
}

/** Stops a lying/truncated upstream before bytes outside the authorized range are forwarded. */
export function boundedResponseBody(
  body: ReadableStream<Uint8Array> | null,
  expectedBytes: number
): ReadableStream<Uint8Array> {
  if (!body) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  let forwarded = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        forwarded += chunk.byteLength;
        if (forwarded > expectedBytes) {
          throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (forwarded !== expectedBytes) {
          throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
        }
      }
    })
  );
}

export interface PreviewGrantContext {
  teamId: string;
  actorId: string;
  materialId: string;
  maxRangeBytes: number;
  toolId?: string | null;
  purpose?: 'preview_range' | 'download_range' | 'process_input';
}

export interface LivePreviewSource {
  fileId: string;
  resourceKey: string | null;
  sizeBytes: number;
  mimeType: string;
  canDownload: boolean;
  sourceVersion?: string | null;
  sourceChecksum?: string | null;
}

export interface PreviewRangeDependencies {
  consumeGrant: (ticket: string) => Promise<PreviewGrantContext | null>;
  loadMaterial: (grant: PreviewGrantContext) => Promise<PreviewMaterialRecord | null>;
  proveLiveAccess: (
    material: PreviewMaterialRecord,
    grant: PreviewGrantContext
  ) => Promise<LivePreviewSource>;
}

export async function authorizePreviewRange(
  input: { ticket: string; rangeHeader: string | null },
  dependencies: PreviewRangeDependencies
) {
  if (input.ticket.length < 8 || input.ticket.length > 2048) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  const grant = await dependencies.consumeGrant(input.ticket);
  if (!grant) throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  const material = await dependencies.loadMaterial(grant);
  if (!material || material.teamId !== grant.teamId || material.materialId !== grant.materialId) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  const live = await dependencies.proveLiveAccess(material, grant);
  if (!live.canDownload) throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  return {
    grant,
    material,
    source: live,
    range: parseBoundedRange(input.rangeHeader, live.sizeBytes, grant.maxRangeBytes)
  };
}

export type PreviewMeasurementCategory = 'video' | 'image' | 'transcript' | 'archive' | 'landing';

export interface PreviewStartMeasurement {
  category: PreviewMeasurementCategory;
  cache: 'cold' | 'warm';
  network: string;
  elapsedMs: number;
  outcome: 'useful' | 'loading' | 'typed_error';
  falseReady: boolean;
}

export function summarizePreviewMeasurements(attempts: readonly PreviewStartMeasurement[]) {
  const usefulWithinTarget = attempts.filter(
    attempt => attempt.outcome === 'useful' && attempt.elapsedMs <= 3000
  ).length;
  const typedRemainder = attempts.filter(
    attempt =>
      attempt.elapsedMs <= 3000 &&
      (attempt.outcome === 'loading' || attempt.outcome === 'typed_error')
  ).length;
  const falseReady = attempts.filter(attempt => attempt.falseReady).length;
  return {
    attempts: attempts.length,
    usefulWithinTarget,
    typedRemainder,
    falseReady,
    meetsSc006:
      attempts.length === 100 &&
      usefulWithinTarget >= 95 &&
      usefulWithinTarget + typedRemainder === attempts.length &&
      falseReady === 0
  };
}

/**
 * The two ways a thumbnail may be asked for (011). A grant is bound to one
 * material and consumed per read; a session is bound to a team and names the
 * material in the query, so a grid of two hundred rows costs one mint.
 */
export type ThumbnailRequest =
  { mode: 'grant'; ticket: string } | { mode: 'session'; ticket: string; materialId: string };

export function parseThumbnailRequest(url: URL): ThumbnailRequest | null {
  const session = url.searchParams.get('session');
  const material = url.searchParams.get('material');
  if (session !== null || material !== null) {
    if (!session || session.length < 16 || session.length > 512) return null;
    if (!material || !UUID.test(material)) return null;
    return { mode: 'session', ticket: session, materialId: material.toLowerCase() };
  }
  const grant = url.searchParams.get('grant');
  if (!grant || grant.length < 16 || grant.length > 512) return null;
  return { mode: 'grant', ticket: grant };
}
