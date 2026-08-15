import { TeamFunctionError } from './errors.ts';
import { isRecord } from './validation.ts';

export interface DriveCapabilities {
  canDownload: boolean;
  canListChildren: boolean;
  canAddChildren: boolean;
  canRename: boolean;
  canMoveItemWithinDrive: boolean;
  canMoveItemOutOfDrive: boolean;
  canModifyContent: boolean;
  canShare?: boolean;
  canTrash: boolean;
  canUntrash: boolean;
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  driveId: string | null;
  resourceKey: string | null;
  shortcutTargetId: string | null;
  shortcutTargetResourceKey: string | null;
  capabilities: DriveCapabilities;
  size: number | null;
  modifiedAt: string | null;
  version: string | null;
  checksum: string | null;
  webViewLink?: string | null;
  thumbnailLink?: string | null;
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file: DriveFileMetadata | null;
}

const FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'parents',
  'trashed',
  'driveId',
  'resourceKey',
  'shortcutDetails(targetId,targetMimeType,targetResourceKey)',
  'capabilities(canDownload,canListChildren,canAddChildren,canRename,canMoveItemWithinDrive,canMoveItemOutOfDrive,canModifyContent,canShare,canTrash,canUntrash)',
  'size',
  'modifiedTime',
  'version',
  'md5Checksum',
  'webViewLink',
  'thumbnailLink'
].join(',');

function parseCapabilities(value: unknown): DriveCapabilities | null {
  if (!isRecord(value)) return null;
  const capability = (name: keyof DriveCapabilities) => value[name] === true;
  return {
    canDownload: capability('canDownload'),
    canListChildren: capability('canListChildren'),
    canAddChildren: capability('canAddChildren'),
    canRename: capability('canRename'),
    canMoveItemWithinDrive: capability('canMoveItemWithinDrive'),
    canMoveItemOutOfDrive: capability('canMoveItemOutOfDrive'),
    canModifyContent: capability('canModifyContent'),
    canShare: capability('canShare'),
    canTrash: capability('canTrash'),
    canUntrash: capability('canUntrash')
  };
}

function parseMetadata(value: unknown): DriveFileMetadata | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !Array.isArray(value.parents) ||
    !value.parents.every(parent => typeof parent === 'string') ||
    typeof value.trashed !== 'boolean'
  ) {
    return null;
  }
  const capabilities = parseCapabilities(value.capabilities);
  if (!capabilities) return null;
  const shortcut = isRecord(value.shortcutDetails) ? value.shortcutDetails : null;
  const parsedSize =
    typeof value.size === 'string' && /^\d+$/.test(value.size) ? Number(value.size) : null;
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    parents: value.parents,
    trashed: value.trashed,
    driveId: typeof value.driveId === 'string' ? value.driveId : null,
    resourceKey: typeof value.resourceKey === 'string' ? value.resourceKey : null,
    shortcutTargetId: shortcut && typeof shortcut.targetId === 'string' ? shortcut.targetId : null,
    shortcutTargetResourceKey:
      shortcut && typeof shortcut.targetResourceKey === 'string'
        ? shortcut.targetResourceKey
        : null,
    capabilities,
    size: parsedSize !== null && Number.isSafeInteger(parsedSize) ? parsedSize : null,
    modifiedAt: typeof value.modifiedTime === 'string' ? value.modifiedTime : null,
    version: typeof value.version === 'string' ? value.version : null,
    checksum: typeof value.md5Checksum === 'string' ? value.md5Checksum : null,
    webViewLink: typeof value.webViewLink === 'string' ? value.webViewLink : null,
    thumbnailLink: typeof value.thumbnailLink === 'string' ? value.thumbnailLink : null
  };
}

export class GoogleDriveClient {
  readonly #accessToken: string;
  readonly #fetch: typeof fetch;

  constructor(accessToken: string, fetchImpl: typeof fetch = fetch) {
    if (accessToken.length < 16) throw new TeamFunctionError('NEEDS_REAUTH');
    this.#accessToken = accessToken;
    this.#fetch = fetchImpl;
  }

  async getFile(fileId: string, resourceKey?: string | null): Promise<DriveFileMetadata> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields', FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');
    if (resourceKey) url.searchParams.set('resourceKey', resourceKey);
    const response = await this.#request(url);
    const parsed = parseMetadata(await response.json().catch(() => null));
    if (!parsed) throw new TeamFunctionError('INVALID_RESPONSE');
    return parsed;
  }

  async listFolders(input: {
    parentId: string;
    pageToken?: string | null;
    driveId?: string | null;
  }): Promise<{ files: DriveFileMetadata[]; nextPageToken: string | null }> {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set(
      'q',
      `'${input.parentId.replaceAll("'", "\\'")}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (input.pageToken) url.searchParams.set('pageToken', input.pageToken);
    if (input.driveId) {
      url.searchParams.set('corpora', 'drive');
      url.searchParams.set('driveId', input.driveId);
    }
    const response = await this.#request(url);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !Array.isArray(payload.files)) {
      throw new TeamFunctionError('INVALID_RESPONSE');
    }
    // A Drive listing can contain an item whose metadata is no longer readable
    // to the connected account.  Do not let one such item stop the entire
    // catalog; it cannot be safely cataloged and will be picked up by a later
    // change or reconciliation once it is readable again.
    const files = payload.files
      .map(parseMetadata)
      .filter((file): file is DriveFileMetadata => file !== null);
    return {
      files,
      nextPageToken: typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null
    };
  }

  async listChildren(input: {
    parentId: string;
    pageToken?: string | null;
    driveId?: string | null;
  }): Promise<{ files: DriveFileMetadata[]; nextPageToken: string | null }> {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set(
      'q',
      `'${input.parentId.replaceAll("'", "\\'")}' in parents and trashed = false`
    );
    url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (input.pageToken) url.searchParams.set('pageToken', input.pageToken);
    if (input.driveId) {
      url.searchParams.set('corpora', 'drive');
      url.searchParams.set('driveId', input.driveId);
    }
    const response = await this.#request(url);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !Array.isArray(payload.files)) {
      throw new TeamFunctionError('INVALID_RESPONSE');
    }
    // See listFolders: retain only complete, safe-to-catalog metadata instead
    // of permanently failing the whole connected Drive scan.
    const files = payload.files
      .map(parseMetadata)
      .filter((file): file is DriveFileMetadata => file !== null);
    return {
      files,
      nextPageToken: typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null
    };
  }

  async listChanges(input: { pageToken: string; driveId?: string | null }): Promise<{
    changes: DriveChange[];
    nextPageToken: string | null;
    newStartPageToken: string | null;
  }> {
    const url = new URL('https://www.googleapis.com/drive/v3/changes');
    url.searchParams.set('pageToken', input.pageToken);
    url.searchParams.set(
      'fields',
      `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`
    );
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (input.driveId) url.searchParams.set('driveId', input.driveId);
    const response = await this.#request(url);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !Array.isArray(payload.changes)) {
      throw new TeamFunctionError('INVALID_RESPONSE');
    }
    const changes: DriveChange[] = [];
    for (const raw of payload.changes) {
      if (!isRecord(raw) || typeof raw.fileId !== 'string') {
        throw new TeamFunctionError('INVALID_RESPONSE');
      }
      // Change records can legitimately carry no readable file payload (for
      // example after a permission change).  Treat it as unavailable so the
      // catalog tombstones the old projection instead of halting all future
      // synchronization on this one record.
      const file = raw.file === undefined || raw.file === null ? null : parseMetadata(raw.file);
      changes.push({ fileId: raw.fileId, removed: raw.removed === true, file });
    }
    return {
      changes,
      nextPageToken: typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null,
      newStartPageToken:
        typeof payload.newStartPageToken === 'string' ? payload.newStartPageToken : null
    };
  }

  async createFolder(input: { name: string; parentId: string }): Promise<DriveFileMetadata> {
    if (
      input.name.length < 1 ||
      input.name.length > 1024 ||
      input.parentId.length < 1 ||
      /[\u0000\r\n]/u.test(input.name)
    ) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', FILE_FIELDS);
    const response = await this.#request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        name: input.name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [input.parentId]
      })
    });
    const metadata = parseMetadata(await response.json().catch(() => null));
    if (!metadata || metadata.mimeType !== 'application/vnd.google-apps.folder') {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    }
    return metadata;
  }

  async listAnyonePermissions(fileId: string): Promise<Array<{ id: string; role: string }>> {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`
    );
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', 'permissions(id,type,role)');
    const response = await this.#request(url);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !Array.isArray(payload.permissions)) {
      throw new TeamFunctionError('INVALID_RESPONSE');
    }
    const permissions: Array<{ id: string; role: string }> = [];
    for (const raw of payload.permissions) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.role !== 'string') {
        throw new TeamFunctionError('INVALID_RESPONSE');
      }
      if (raw.type === 'anyone') permissions.push({ id: raw.id, role: raw.role });
    }
    return permissions;
  }

  async createAnyoneReaderPermission(fileId: string): Promise<{ id: string; role: 'reader' }> {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`
    );
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('sendNotificationEmail', 'false');
    url.searchParams.set('fields', 'id,type,role');
    const response = await this.#request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false })
    });
    const payload: unknown = await response.json().catch(() => null);
    if (
      !isRecord(payload) ||
      typeof payload.id !== 'string' ||
      payload.type !== 'anyone' ||
      payload.role !== 'reader'
    ) {
      throw new TeamFunctionError('INVALID_RESPONSE');
    }
    return { id: payload.id, role: 'reader' };
  }

  async downloadFileRange(input: {
    fileId: string;
    resourceKey?: string | null;
    maximumBytes: number;
  }): Promise<{ bytes: Uint8Array; totalBytes: number | null }> {
    const maximumBytes = Math.min(Math.max(Math.trunc(input.maximumBytes), 1), 32 * 1024 * 1024);
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}`
    );
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');
    if (input.resourceKey) url.searchParams.set('resourceKey', input.resourceKey);
    const response = await this.#request(url, {
      headers: { range: `bytes=0-${maximumBytes - 1}` }
    });
    const reader = response.body?.getReader();
    if (!reader) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maximumBytes) {
        await reader.cancel();
        throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
      }
      chunks.push(value);
      size += value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const contentRange = response.headers.get('content-range');
    const totalMatch = contentRange?.match(/\/(\d+)$/);
    const contentLength = Number(response.headers.get('content-length'));
    const totalBytes = totalMatch
      ? Number(totalMatch[1])
      : Number.isSafeInteger(contentLength) && contentLength >= 0
        ? contentLength
        : null;
    return { bytes, totalBytes: Number.isSafeInteger(totalBytes) ? totalBytes : null };
  }

  /**
   * Opens one provider byte range without buffering it. The caller owns the
   * response body and must forward or cancel it. This is intentionally the
   * only streaming primitive exposed by the credential-bearing Drive client.
   */
  async fetchFileRange(input: {
    fileId: string;
    resourceKey?: string | null;
    start: number;
    end: number;
    signal?: AbortSignal;
  }): Promise<Response> {
    if (
      !Number.isSafeInteger(input.start) ||
      !Number.isSafeInteger(input.end) ||
      input.start < 0 ||
      input.end < input.start ||
      input.end - input.start + 1 > 32 * 1024 * 1024
    ) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}`
    );
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');
    if (input.resourceKey) url.searchParams.set('resourceKey', input.resourceKey);
    return this.#request(url, {
      headers: { range: `bytes=${input.start}-${input.end}` },
      signal: input.signal
    });
  }

  /**
   * Reads the provider-generated visual thumbnail without exposing the provider
   * URL or the shared Drive credential to the browser.  Drive owns this URL;
   * we still restrict it to Google's image hosts before requesting it.
   */
  async fetchThumbnail(input: { thumbnailLink: string; signal?: AbortSignal }): Promise<Response> {
    let url: URL;
    try {
      url = new URL(input.thumbnailLink);
    } catch {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !isGoogleThumbnailHost(url.hostname)
    ) {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    }
    return this.#request(url, {
      headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      signal: input.signal
    });
  }

  async startResumableUpload(input: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    parentId: string;
    existingFileId?: string | null;
  }): Promise<{ sessionUri: string; expiresAt: string }> {
    if (
      input.name.length < 1 ||
      input.name.length > 1024 ||
      input.mimeType.length < 1 ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.parentId.length < 1
    ) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const path = input.existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(input.existingFileId)}`
      : 'https://www.googleapis.com/upload/drive/v3/files';
    const url = new URL(path);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('supportsAllDrives', 'true');
    const metadata = input.existingFileId
      ? { name: input.name }
      : { name: input.name, mimeType: input.mimeType, parents: [input.parentId] };
    const response = await this.#request(url, {
      method: input.existingFileId ? 'PATCH' : 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-upload-content-length': String(input.sizeBytes),
        'x-upload-content-type': input.mimeType
      },
      body: JSON.stringify(metadata)
    });
    const location = response.headers.get('location');
    if (!location) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    let session: URL;
    try {
      session = new URL(location);
    } catch {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    }
    if (
      session.protocol !== 'https:' ||
      !['www.googleapis.com', 'content.googleapis.com'].includes(session.hostname) ||
      session.username ||
      session.password ||
      session.hash
    ) {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    }
    return {
      sessionUri: session.toString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    };
  }

  async relayResumableChunk(input: {
    sessionUri: string;
    contentRange: string;
    contentLength: number;
    body: ReadableStream<Uint8Array> | null;
    signal?: AbortSignal;
  }): Promise<Response> {
    let url: URL;
    try {
      url = new URL(input.sessionUri);
    } catch {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    if (
      url.protocol !== 'https:' ||
      !['www.googleapis.com', 'content.googleapis.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.hash ||
      !Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 0
    ) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.#accessToken}`,
          'content-length': String(input.contentLength),
          'content-range': input.contentRange
        },
        body: input.body,
        signal: input.signal ?? AbortSignal.timeout(30_000),
        redirect: 'error'
      });
    } catch {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }
    if ([200, 201, 308].includes(response.status)) return response;
    if (response.status === 401) throw new TeamFunctionError('NEEDS_REAUTH');
    if (response.status === 403 || response.status === 404) {
      throw new TeamFunctionError('PERMISSION_DENIED');
    }
    if (response.status === 429) {
      throw new TeamFunctionError('RATE_LIMITED', { retryable: true });
    }
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: response.status >= 500 });
  }

  async updateFileMetadata(input: {
    fileId: string;
    resourceKey?: string | null;
    name?: string;
    trashed?: boolean;
    addParentId?: string;
    removeParentIds?: string[];
  }): Promise<DriveFileMetadata> {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}`
    );
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', FILE_FIELDS);
    if (input.resourceKey) url.searchParams.set('resourceKey', input.resourceKey);
    if (input.addParentId) url.searchParams.set('addParents', input.addParentId);
    if (input.removeParentIds?.length) {
      url.searchParams.set('removeParents', input.removeParentIds.join(','));
    }
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.trashed !== undefined) body.trashed = input.trashed;
    const response = await this.#request(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });
    const metadata = parseMetadata(await response.json().catch(() => null));
    if (!metadata) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    return metadata;
  }

  async updateSmallFileContent(input: {
    fileId: string;
    resourceKey?: string | null;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<DriveFileMetadata> {
    if (input.bytes.byteLength > 1024 * 1024) {
      throw new TeamFunctionError('TOO_LARGE', { retryable: false });
    }
    const url = new URL(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(input.fileId)}`
    );
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', FILE_FIELDS);
    if (input.resourceKey) url.searchParams.set('resourceKey', input.resourceKey);
    const response = await this.#request(url, {
      method: 'PATCH',
      headers: { 'content-type': input.mimeType },
      body: input.bytes
    });
    const metadata = parseMetadata(await response.json().catch(() => null));
    if (!metadata) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    return metadata;
  }

  async #request(url: URL, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${this.#accessToken}`, ...init.headers },
        signal: init.signal ?? AbortSignal.timeout(15_000)
      });
    } catch {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }
    if (response.ok) return response;
    if (response.status === 401) throw new TeamFunctionError('NEEDS_REAUTH');
    if (response.status === 403 || response.status === 404) {
      throw new TeamFunctionError('PERMISSION_DENIED');
    }
    if (response.status === 429) throw new TeamFunctionError('RATE_LIMITED', { retryable: true });
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: response.status >= 500 });
  }
}

function isGoogleThumbnailHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase('en-US');
  return (
    host === 'drive.google.com' ||
    host === 'docs.google.com' ||
    host === 'googleusercontent.com' ||
    host.endsWith('.googleusercontent.com')
  );
}

export async function proveLiveAncestry(input: {
  client: GoogleDriveClient;
  fileId: string;
  rootFolderId: string;
  resourceKey?: string | null;
  maximumDepth?: number;
  allowTrashedTarget?: boolean;
}): Promise<DriveFileMetadata> {
  const maximumDepth = Math.min(Math.max(input.maximumDepth ?? 100, 1), 100);
  const target = await input.client.getFile(input.fileId, input.resourceKey);
  if (target.trashed && !input.allowTrashedTarget) throw new TeamFunctionError('NOT_FOUND');
  if (target.id === input.rootFolderId) return target;
  if (target.shortcutTargetId) throw new TeamFunctionError('UNSUPPORTED_MEDIA');

  let frontier = [...target.parents];
  const visited = new Set<string>();
  for (let depth = 0; depth < maximumDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const parentId of frontier) {
      if (parentId === input.rootFolderId) return target;
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const parent = await input.client.getFile(parentId);
      if (parent.trashed) continue;
      next.push(...parent.parents);
    }
    frontier = next;
  }
  throw new TeamFunctionError('ROOT_ESCAPE');
}

export function requireDriveCapability(
  metadata: DriveFileMetadata,
  capability: keyof DriveCapabilities
): void {
  if (!metadata.capabilities[capability]) throw new TeamFunctionError('PERMISSION_DENIED');
}
