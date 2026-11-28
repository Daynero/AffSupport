/**
 * 057 T045: what an upload into an R2 space has done so far, kept in IndexedDB so a reload, a
 * lost network or a sleeping laptop resumes it instead of starting again (after
 * `workspaceOperationJournal.ts`). One entry per file, keyed by where it goes and what the file
 * looks like (name, size, last change); nothing in it is a secret or the file's bytes.
 *
 * Every access is guarded: private mode or blocked storage means no journal, never a failed
 * upload.
 */
export interface SpaceUploadJournalEntry {
  key: string;
  teamId: string;
  idempotencyKey: string;
  /** Part MD5s in order; with them a resumed upload does not read the file again to hash it. */
  md5s: string[];
  contentId: string;
  uploadId: string | null;
  expiresAt: string | null;
  /** Parts R2 acknowledged, by part number: the ETag it returned. */
  etags: Record<number, string>;
  updatedAt: number;
}

export interface SpaceUploadJournal {
  get(key: string): Promise<SpaceUploadJournalEntry | null>;
  put(entry: SpaceUploadJournalEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** Everything of one account or all of it (logout, account switch). */
  clear(): Promise<void>;
}

const STORE = 'uploads';
/** Older than the server's session (24 h) is no use to anyone. */
export const SPACE_UPLOAD_JOURNAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function spaceUploadJournalKey(input: {
  actorId: string;
  teamId: string;
  parentMaterialId: string | null;
  name: string;
  size: number;
  lastModified: number | null;
}): string | null {
  if (input.lastModified === null) return null;
  return [
    input.actorId,
    input.teamId,
    input.parentMaterialId ?? 'root',
    input.size,
    input.lastModified,
    input.name
  ].join('|');
}

function isEntry(value: unknown): value is SpaceUploadJournalEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === 'string' &&
    typeof entry.teamId === 'string' &&
    typeof entry.idempotencyKey === 'string' &&
    Array.isArray(entry.md5s) &&
    entry.md5s.every(md5 => typeof md5 === 'string' && /^[0-9a-f]{32}$/u.test(md5)) &&
    typeof entry.contentId === 'string' &&
    (entry.uploadId === null || typeof entry.uploadId === 'string') &&
    (entry.expiresAt === null || typeof entry.expiresAt === 'string') &&
    !!entry.etags &&
    typeof entry.etags === 'object' &&
    typeof entry.updatedAt === 'number'
  );
}

export function memorySpaceUploadJournal(): SpaceUploadJournal {
  const entries = new Map<string, SpaceUploadJournalEntry>();
  return {
    get: async key => {
      const entry = entries.get(key);
      return entry ? structuredClone(entry) : null;
    },
    put: async entry => {
      entries.set(entry.key, structuredClone(entry));
    },
    delete: async key => {
      entries.delete(key);
    },
    clear: async () => {
      entries.clear();
    }
  };
}

function request<T>(
  run: (store: IDBObjectStore) => IDBRequest<T>,
  db: IDBDatabase,
  mode: IDBTransactionMode
) {
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const pending = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(pending.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function indexedDbSpaceUploadJournal(name = 'soty-space-uploads'): SpaceUploadJournal {
  let opened: Promise<IDBDatabase | null> | null = null;
  const database = () =>
    (opened ??= new Promise<IDBDatabase | null>(resolve => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'key' });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => resolve(null);
        open.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }));
  const guarded = async <T>(fallback: T, run: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    try {
      const db = await database();
      return db ? await run(db) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    get: key =>
      guarded(null, async db => {
        const value: unknown = await request(store => store.get(key), db, 'readonly');
        if (!isEntry(value)) return null;
        return Date.now() - value.updatedAt > SPACE_UPLOAD_JOURNAL_MAX_AGE_MS ? null : value;
      }),
    put: entry =>
      guarded(undefined, async db => {
        await request(store => store.put(structuredClone(entry)), db, 'readwrite');
      }),
    delete: key =>
      guarded(undefined, async db => {
        await request(store => store.delete(key), db, 'readwrite');
      }),
    clear: () =>
      guarded(undefined, async db => {
        await request(store => store.clear(), db, 'readwrite');
      })
  };
}
