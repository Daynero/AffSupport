import { privateCacheActor, registerPrivateCache } from '../private-cache-scope';

/**
 * 057 (FR-037, R8): what an R2 space looked like the last time this browser read it — the
 * folder tree with its counters and the first page of each folder opened — kept in IndexedDB,
 * so opening the space again paints at once and the reads that always run bring it up to date
 * underneath (stale-while-revalidate).
 *
 * What it is not: a source of truth. Rights, quota and deletion are decided by the server on
 * every call; a cached row is only ever shown, never acted on without a read. Each record
 * belongs to one account in one space, the whole store goes with a sign-out or a change of
 * account, and a space the account can no longer see is dropped when its list is confirmed.
 *
 * Every storage call is wrapped: a private window, a blocked or full IndexedDB, or a record
 * from another build degrades to "nothing cached", never to a broken page.
 */

/** Bumped whenever a cached shape changes; a record of another version is ignored and dropped. */
export const SPACE_CACHE_VERSION = 1;
/** How many records the store keeps, all accounts and spaces together. */
export const SPACE_CACHE_MAX_ENTRIES = 120;
/** Roughly how much the store keeps, counted as UTF-16 of the JSON of each value. */
export const SPACE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** A single value larger than this (a huge tree) is not worth keeping at all. */
export const SPACE_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;

export type SpaceCacheKind = 'tree' | 'page';

export interface SpaceCacheAddress {
  actorId: string;
  teamId: string;
  kind: SpaceCacheKind;
  /** What within the space: the folder and filter of a page; empty for the tree. */
  scope: string;
}

export interface SpaceCacheMeta extends SpaceCacheAddress {
  key: string;
  version: number;
  bytes: number;
  usedAt: number;
}

export interface SpaceCacheRecord extends SpaceCacheMeta {
  value: unknown;
}

/** Where records live: IndexedDB in a browser, memory in tests. */
export interface SpaceCacheStorage {
  get(key: string): Promise<SpaceCacheRecord | undefined>;
  put(record: SpaceCacheRecord): Promise<void>;
  /** Records the use of an entry without rewriting its value. */
  touch(meta: SpaceCacheMeta): Promise<void>;
  /** Every record's bookkeeping, without loading the values. */
  index(): Promise<SpaceCacheMeta[]>;
  delete(keys: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

function metaOf(record: SpaceCacheRecord): SpaceCacheMeta {
  return {
    key: record.key,
    version: record.version,
    actorId: record.actorId,
    teamId: record.teamId,
    kind: record.kind,
    scope: record.scope,
    bytes: record.bytes,
    usedAt: record.usedAt
  };
}

export class MemorySpaceCacheStorage implements SpaceCacheStorage {
  readonly records = new Map<string, SpaceCacheRecord>();
  async get(key: string): Promise<SpaceCacheRecord | undefined> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : undefined;
  }
  async put(record: SpaceCacheRecord): Promise<void> {
    this.records.set(record.key, structuredClone(record));
  }
  async touch(meta: SpaceCacheMeta): Promise<void> {
    const record = this.records.get(meta.key);
    if (record) record.usedAt = meta.usedAt;
  }
  async index(): Promise<SpaceCacheMeta[]> {
    return [...this.records.values()].map(metaOf);
  }
  async delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.records.delete(key);
  }
  async clear(): Promise<void> {
    this.records.clear();
  }
}

const DATABASE = 'soty-space-cache';
const VALUES = 'values';
const META = 'meta';

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Two stores, so the LRU can be read without loading every value: `meta` holds what eviction
 * needs, `values` what a screen paints. Both are written in one transaction.
 */
class IndexedDBSpaceCacheStorage implements SpaceCacheStorage {
  #database: Promise<IDBDatabase> | null = null;
  #open(): Promise<IDBDatabase> {
    this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(VALUES, { keyPath: 'key' });
        request.result.createObjectStore(META, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('SPACE_CACHE_BLOCKED'));
    });
    return this.#database;
  }
  async get(key: string): Promise<SpaceCacheRecord | undefined> {
    const db = await this.#open();
    const transaction = db.transaction([VALUES, META]);
    const [value, meta] = await Promise.all([
      result(transaction.objectStore(VALUES).get(key)),
      result(transaction.objectStore(META).get(key))
    ]);
    if (!value || !meta) return undefined;
    return { ...(meta as SpaceCacheMeta), value: (value as { value: unknown }).value };
  }
  async put(record: SpaceCacheRecord): Promise<void> {
    const db = await this.#open();
    const transaction = db.transaction([VALUES, META], 'readwrite');
    transaction.objectStore(VALUES).put({ key: record.key, value: record.value });
    transaction.objectStore(META).put(metaOf(record));
    await done(transaction);
  }
  async touch(meta: SpaceCacheMeta): Promise<void> {
    const db = await this.#open();
    const transaction = db.transaction(META, 'readwrite');
    transaction.objectStore(META).put(meta);
    await done(transaction);
  }
  async index(): Promise<SpaceCacheMeta[]> {
    const db = await this.#open();
    return (await result(db.transaction(META).objectStore(META).getAll())) as SpaceCacheMeta[];
  }
  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await this.#open();
    const transaction = db.transaction([VALUES, META], 'readwrite');
    for (const key of keys) {
      transaction.objectStore(VALUES).delete(key);
      transaction.objectStore(META).delete(key);
    }
    await done(transaction);
  }
  async clear(): Promise<void> {
    const db = await this.#open();
    const transaction = db.transaction([VALUES, META], 'readwrite');
    transaction.objectStore(VALUES).clear();
    transaction.objectStore(META).clear();
    await done(transaction);
  }
}

/*
 * Whether this browser has ever cached a space. Without the mark the store was never opened,
 * so a person who only has Drive spaces never has an IndexedDB database made for them by the
 * clean-up that runs on every confirmed space list.
 */
const USED_MARK = 'soty.space-cache.used.v1';
function markUsed(): void {
  try {
    window.localStorage.setItem(USED_MARK, '1');
  } catch {
    // Without the mark the clean-up only runs once something is cached again.
  }
}
function everUsed(): boolean {
  try {
    return window.localStorage.getItem(USED_MARK) === '1';
  } catch {
    return true;
  }
}
function forgetUsed(): void {
  try {
    window.localStorage.removeItem(USED_MARK);
  } catch {
    // Harmless: the next clean-up opens an empty store.
  }
}

function defaultStorage(): SpaceCacheStorage | null {
  try {
    return typeof indexedDB === 'undefined' ? null : new IndexedDBSpaceCacheStorage();
  } catch {
    return null;
  }
}

function parseSafely<T>(parse: (value: unknown) => T | null, value: unknown): T | null {
  try {
    return parse(value);
  } catch {
    return null;
  }
}

function keyOf(address: SpaceCacheAddress): string {
  return JSON.stringify([address.actorId, address.teamId, address.kind, address.scope]);
}

function sizeOf(value: unknown): number | null {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return null;
  }
}

class SpaceCache {
  #storage: SpaceCacheStorage | null | undefined;
  #index: Map<string, SpaceCacheMeta> | null = null;
  /** Every write and purge in order, so a purge is never overtaken by a write it should erase. */
  #queue: Promise<unknown> = Promise.resolve();
  #clock = 0;

  use(storage: SpaceCacheStorage | null | undefined): void {
    this.#storage = storage;
    this.#index = null;
    this.#queue = Promise.resolve();
  }

  #store(): SpaceCacheStorage | null {
    if (this.#storage === undefined) this.#storage = defaultStorage();
    return this.#storage;
  }

  /** A storage that failed once is not asked again this session. */
  #disable(): void {
    this.#storage = null;
    this.#index = null;
  }

  #now(): number {
    this.#clock = Math.max(Date.now(), this.#clock + 1);
    return this.#clock;
  }

  #enqueue<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    const next = this.#queue.then(work).catch(() => {
      this.#disable();
      return fallback;
    });
    this.#queue = next;
    return next;
  }

  async #loadIndex(store: SpaceCacheStorage): Promise<Map<string, SpaceCacheMeta>> {
    if (!this.#index) {
      const index = new Map<string, SpaceCacheMeta>();
      for (const meta of await store.index()) index.set(meta.key, meta);
      this.#index = index;
    }
    return this.#index;
  }

  read<T>(address: SpaceCacheAddress, parse: (value: unknown) => T | null): Promise<T | null> {
    return this.#enqueue(async () => {
      const store = this.#store();
      if (!store) return null;
      const key = keyOf(address);
      const record = await store.get(key);
      if (!record) return null;
      const parsed =
        record.version === SPACE_CACHE_VERSION &&
        record.actorId === address.actorId &&
        record.teamId === address.teamId &&
        record.kind === address.kind &&
        record.scope === address.scope
          ? parseSafely(parse, record.value)
          : null;
      if (parsed === null) {
        this.#index?.delete(key);
        await store.delete([key]);
        return null;
      }
      const meta = { ...metaOf(record), usedAt: this.#now() };
      this.#index?.set(key, meta);
      await store.touch(meta);
      return parsed;
    }, null);
  }

  write(address: SpaceCacheAddress, value: unknown | null): Promise<void> {
    return this.#enqueue(async () => {
      const store = this.#store();
      if (!store) return;
      const index = await this.#loadIndex(store);
      const key = keyOf(address);
      const bytes = value === null ? null : sizeOf(value);
      if (bytes === null || bytes > SPACE_CACHE_MAX_ENTRY_BYTES) {
        if (index.delete(key)) await store.delete([key]);
        return;
      }
      const meta: SpaceCacheMeta = {
        ...address,
        key,
        version: SPACE_CACHE_VERSION,
        bytes,
        usedAt: this.#now()
      };
      markUsed();
      await store.put({ ...meta, value });
      index.set(key, meta);
      await store.delete(this.#evict(index));
    }, undefined);
  }

  /** Oldest first until the store is back inside both limits. */
  #evict(index: Map<string, SpaceCacheMeta>): string[] {
    let bytes = 0;
    for (const meta of index.values()) bytes += meta.bytes;
    if (index.size <= SPACE_CACHE_MAX_ENTRIES && bytes <= SPACE_CACHE_MAX_BYTES) return [];
    const evicted: string[] = [];
    const oldest = [...index.values()].sort((left, right) => left.usedAt - right.usedAt);
    for (const meta of oldest) {
      if (index.size <= SPACE_CACHE_MAX_ENTRIES && bytes <= SPACE_CACHE_MAX_BYTES) break;
      index.delete(meta.key);
      bytes -= meta.bytes;
      evicted.push(meta.key);
    }
    return evicted;
  }

  /** Keeps only this account's records of these spaces. */
  retain(actorId: string, teamIds: ReadonlySet<string>): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#storage === undefined && !everUsed()) return;
      const store = this.#store();
      if (!store) return;
      const index = await this.#loadIndex(store);
      const doomed = [...index.values()]
        .filter(meta => meta.actorId !== actorId || !teamIds.has(meta.teamId))
        .map(meta => meta.key);
      for (const key of doomed) index.delete(key);
      await store.delete(doomed);
    }, undefined);
  }

  clear(): Promise<void> {
    return this.#enqueue(async () => {
      this.#index = new Map();
      if (this.#storage === undefined && !everUsed()) return;
      const store = this.#store();
      forgetUsed();
      await store?.clear();
    }, undefined);
  }

  /** Resolves once everything asked so far has been written (tests). */
  settled(): Promise<void> {
    return this.#queue.then(
      () => undefined,
      () => undefined
    );
  }
}

const cache = new SpaceCache();

/** The cached value at this address, or null; a malformed or foreign record is dropped. */
export function readSpaceCache<T>(
  address: SpaceCacheAddress,
  parse: (value: unknown) => T | null
): Promise<T | null> {
  return cache.read(address, parse);
}

/** Stores a value (null removes it); fire and forget — a failure only means no warm start. */
export function writeSpaceCache(address: SpaceCacheAddress, value: unknown | null): void {
  void cache.write(address, value);
}

/** After a confirmed space list: drops other accounts' records and spaces no longer visible. */
export function retainSpaceCache(actorId: string, teamIds: Iterable<string>): Promise<void> {
  return cache.retain(actorId, new Set(teamIds));
}

/** Forgets everything cached, for every account and space. */
export function clearSpaceCache(): Promise<void> {
  return cache.clear();
}

export function spaceCacheSettled(): Promise<void> {
  return cache.settled();
}

/** Puts the cache on another storage — memory in tests, null for none; undefined restores. */
export function setSpaceCacheStorage(storage: SpaceCacheStorage | null | undefined): void {
  cache.use(storage);
}

/*
 * A sign-out or a change of account empties the store (private-cache-scope). A sign-in from
 * nobody — every page load — keeps it: that is the warm start this cache exists for; another
 * account's leftovers go when the new account's space list is confirmed (`retainSpaceCache`).
 * The check waits a microtask because a remount (React's strict mode, a provider moving)
 * clears the scope and sets the same account again in one go, and that is not a sign-out.
 */
let cacheActor: string | null = privateCacheActor();
registerPrivateCache(() => {
  const actor = privateCacheActor();
  if (actor === cacheActor) return;
  const previous = cacheActor;
  cacheActor = actor;
  if (previous === null) return;
  queueMicrotask(() => {
    if (privateCacheActor() !== previous) void cache.clear();
  });
});
