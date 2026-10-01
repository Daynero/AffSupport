import { GoogleDriveClient, type DriveFileMetadata, proveLiveAncestry } from './drive.ts';
import { TeamFunctionError } from './errors.ts';
import { validThumbnail } from './thumbnails.ts';

export const CACHE_FOLDER_NAME = 'Soty Cache';
export const CACHE_FOLDER_MARK = 'soty.cache';
export const CACHE_README = `# Soty Cache — службова папка простору

Цю папку автоматично створює Soty у підключеному Google Drive.
Медіафайли в ній зберігаються у вашому Drive, а не у сховищі сервера Soty.

Thumbnails — мініатюри та постери для швидкого перегляду матеріалів.
Landing previews — підготовлені зображення сторінок лендінгів.
Restitched — автоматично створені перезашиті відео.
Task attachments — файли, прикріплені до завдань.
Soty — інші файли, які створює простір.

НЕ ВИДАЛЯЙТЕ ЦЮ ПАПКУ ТА ЇЇ ВМІСТ ВРУЧНУ.
Це не лише тимчасовий кеш: тут можуть бути результати роботи та вкладення.
Видалення може зламати прев’ю, посилання у завданнях і автоматичне оновлення
відео, а також призвести до втрати файлів. Частину прев’ю можна відновити,
але результати роботи та вкладення не завжди можна відтворити.
Не переміщуйте папку за межі підключеного простору та не обмежуйте її доступ
для учасників, яким потрібні ці матеріали. Оригінали ваших матеріалів Soty
не переносить у кеш і не видаляє.

Папка використовує місце та права доступу вашого Google Drive.
Для очищення або відключення спочатку перевірте залежні матеріали у Soty.
`;

type CacheDrive = Pick<
  GoogleDriveClient,
  | 'findFolderByAppProperty'
  | 'createFolder'
  | 'listChildren'
  | 'createConvertedFile'
  | 'fetchFileRange'
  | 'getFile'
  | 'updateFileMetadata'
>;

async function children(drive: CacheDrive, parentId: string): Promise<DriveFileMetadata[]> {
  const files: DriveFileMetadata[] = [];
  let pageToken: string | null = null;
  do {
    const page = await drive.listChildren({ parentId, pageToken });
    if (page.incompleteSearch || page.invalidEntries > 0) {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: true });
    }
    files.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

/** Scoped to this connection's root: another connected folder is never adopted. */
const pendingRoots = new Map<string, Promise<string>>();
const pendingFolders = new Map<string, Promise<string>>();

export function ensureDriveCacheRoot(drive: CacheDrive, teamId: string, rootFolderId: string) {
  const key = `${teamId}:${rootFolderId}`;
  const known = pendingRoots.get(key);
  if (known) return known;
  const pending = initializeDriveCacheRoot(drive, teamId, rootFolderId);
  pendingRoots.set(key, pending);
  void pending.finally(() => pendingRoots.delete(key)).catch(() => undefined);
  return pending;
}

async function initializeDriveCacheRoot(drive: CacheDrive, teamId: string, rootFolderId: string) {
  const marker = `${teamId}:${rootFolderId}`;
  const found = await drive.findFolderByAppProperty({
    key: CACHE_FOLDER_MARK,
    value: marker,
    parentId: rootFolderId
  });
  const folder =
    found ??
    (await drive.createFolder({
      name: CACHE_FOLDER_NAME,
      parentId: rootFolderId,
      appProperties: { [CACHE_FOLDER_MARK]: marker }
    }));
  const files = await children(drive, folder.id);
  if (!files.some(file => !file.trashed && file.appProperties['soty.cache.readme'] === '1')) {
    await drive.createConvertedFile({
      name: 'README.md',
      parentId: folder.id,
      sourceMimeType: 'text/plain',
      targetMimeType: 'text/plain',
      bytes: new TextEncoder().encode(CACHE_README),
      appProperties: { 'soty.cache.readme': '1' }
    });
  }
  await ensureDriveCacheFolder(drive, folder.id, 'Thumbnails');
  await ensureDriveCacheFolder(drive, folder.id, 'Landing previews');
  return folder.id;
}

export function ensureDriveCacheFolder(drive: CacheDrive, parentId: string, name: string) {
  const key = `${parentId}:${name}`;
  const known = pendingFolders.get(key);
  if (known) return known;
  const pending = initializeDriveCacheFolder(drive, parentId, name);
  pendingFolders.set(key, pending);
  void pending.finally(() => pendingFolders.delete(key)).catch(() => undefined);
  return pending;
}

async function initializeDriveCacheFolder(drive: CacheDrive, parentId: string, name: string) {
  const marker = `${parentId}:${name}`;
  const found = await drive.findFolderByAppProperty({
    key: CACHE_FOLDER_MARK,
    value: marker,
    parentId
  });
  return (
    found ??
    (await drive.createFolder({
      name,
      parentId,
      appProperties: {
        [CACHE_FOLDER_MARK]: marker,
        ...(['Thumbnails', 'Landing previews'].includes(name) ? { 'soty.cache.hidden': '1' } : {})
      }
    }))
  ).id;
}

export function isHiddenPreviewCache(file: DriveFileMetadata) {
  return file.name === '.soty' || file.appProperties?.['soty.cache.hidden'] === '1';
}

/** Explicit consolidation, retaining IDs; never adopt an unmarked user folder by name. */
export async function consolidateGeneratedFolders(
  drive: CacheDrive,
  teamId: string,
  rootFolderId: string,
  cacheId: string
) {
  for (const [key, value] of [
    ['soty.workspace', teamId],
    ['soty.restitched', `${teamId}:restitched`],
    ['soty.task-drops', `${teamId}:task-drops`]
  ]) {
    const folder = await drive.findFolderByAppProperty({
      key: key!,
      value: value!,
      parentId: rootFolderId
    });
    if (folder) await moveGeneratedFolderToCache(drive, folder, rootFolderId, cacheId);
  }
  const oldLandings = (await children(drive, rootFolderId)).filter(
    file =>
      !file.trashed &&
      file.name === '.soty' &&
      file.mimeType === 'application/vnd.google-apps.folder'
  );
  if (oldLandings.length) {
    for (const folder of oldLandings) {
      // The old renderer predates app marks. Only adopt its exclusive namespace;
      // an identically named folder containing a user's files stays untouched.
      const entries = (await children(drive, folder.id)).filter(file => !file.trashed);
      if (
        !entries.length ||
        !entries.every(
          file =>
            file.name === 'landing-previews' &&
            file.mimeType === 'application/vnd.google-apps.folder'
        )
      )
        continue;
      const parent = await ensureDriveCacheFolder(drive, cacheId, 'Landing previews');
      await moveGeneratedFolderToCache(drive, folder, rootFolderId, parent);
    }
  }
}

/** Reparent only an app-owned folder proven to belong to the connected root. IDs stay intact. */
export async function moveGeneratedFolderToCache(
  drive: CacheDrive,
  folder: DriveFileMetadata,
  rootFolderId: string,
  cacheId: string
) {
  if (folder.parents.includes(cacheId)) return folder;
  await proveLiveAncestry({ client: drive, fileId: folder.id, rootFolderId });
  return drive.updateFileMetadata({
    fileId: folder.id,
    addParentId: cacheId,
    removeParentIds: folder.parents
  });
}

export class DriveThumbnailCache {
  private root: Promise<string> | null = null;
  private folders = new Map<string, Promise<string>>();
  constructor(
    private drive: CacheDrive,
    private teamId: string,
    private rootFolderId: string
  ) {}

  private async folder(path: string, create: boolean) {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}\.thumbnail$/u.test(path)) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const prefix = path.slice(0, 2);
    if (!create) {
      const root = await this.drive.findFolderByAppProperty({
        key: CACHE_FOLDER_MARK,
        value: `${this.teamId}:${this.rootFolderId}`,
        parentId: this.rootFolderId
      });
      if (!root) return null;
      const thumbnails = await this.drive.findFolderByAppProperty({
        key: CACHE_FOLDER_MARK,
        value: `${root.id}:Thumbnails`,
        parentId: root.id
      });
      if (!thumbnails) return null;
      const shard = await this.drive.findFolderByAppProperty({
        key: CACHE_FOLDER_MARK,
        value: `${thumbnails.id}:${prefix}`,
        parentId: thumbnails.id
      });
      return shard?.id ?? null;
    }
    this.root ??= ensureDriveCacheRoot(this.drive, this.teamId, this.rootFolderId);
    let folder = this.folders.get(prefix);
    if (!folder) {
      folder = this.root.then(async root => {
        const thumbnails = await ensureDriveCacheFolder(this.drive, root, 'Thumbnails');
        return ensureDriveCacheFolder(this.drive, thumbnails, prefix);
      });
      this.folders.set(prefix, folder);
    }
    return folder;
  }

  async read(path: string) {
    const folder = await this.folder(path, false);
    if (!folder) return null;
    const file = (await children(this.drive, folder)).find(
      item => !item.trashed && item.appProperties['soty.thumbnail'] === path
    );
    if (!file || !validThumbnail(file.mimeType, file.size ?? 0)) return null;
    const response = await this.drive.fetchFileRange({
      fileId: file.id,
      resourceKey: file.resourceKey,
      start: 0,
      end: file.size! - 1
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const bytes = new Uint8Array(file.size!);
    let offset = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (offset + chunk.value.length > bytes.length) {
          await reader.cancel();
          return null;
        }
        bytes.set(chunk.value, offset);
        offset += chunk.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    if (offset !== bytes.length) return null;
    if (bytes.length !== file.size || !validThumbnail(file.mimeType, bytes.length)) return null;
    return {
      body: new Blob([bytes], { type: file.mimeType }),
      mimeType: file.mimeType,
      contentLength: bytes.length
    };
  }

  async store(path: string, bytes: Uint8Array, mimeType: string) {
    if (!validThumbnail(mimeType, bytes.byteLength)) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const folder = await this.folder(path, true);
    if (!folder) throw new TeamFunctionError('INVALID_RESPONSE');
    if (
      (await children(this.drive, folder)).some(
        file =>
          !file.trashed &&
          file.appProperties['soty.thumbnail'] === path &&
          validThumbnail(file.mimeType, file.size ?? 0)
      )
    )
      return;
    await this.drive.createConvertedFile({
      name: path.slice(3).replace('.thumbnail', mimeType === 'image/webp' ? '.webp' : '.thumbnail'),
      parentId: folder,
      sourceMimeType: mimeType,
      targetMimeType: mimeType,
      bytes: new Uint8Array(bytes),
      appProperties: { 'soty.thumbnail': path }
    });
  }
}
