import {
  isLocalManifestRelativePath,
  isLocalItemState,
  isLocalOperationStage,
  isLocalOperationState,
  type LocalItemState,
  type LocalOperationStage,
  type LocalOperationState
} from '@video-compressor/shared';
import type { LocalManifest } from './localManifest';

const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const INTERRUPTED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OWNER_LEASE_MS = 30_000;

export interface JournalItem {
  clientItemKey: string;
  kind: 'file' | 'directory';
  relativePath: string;
  parentKey: string | null;
  name: string;
  sizeBytes: number;
  state: LocalItemState;
  errorCode: string | null;
  operationId: string | null;
  resultMaterialId: string | null;
  resultFolderId: string | null;
  idempotencyKey: string;
}

export interface JournalGroup {
  /** Missing only on records written before atomic journal updates. */
  revision?: number;
  key: string;
  id: string;
  actorId: string;
  teamId: string;
  kind: 'upload' | 'move' | 'sync';
  destination: { driveFolderId: string | null; materialId: string | null };
  state: LocalOperationState;
  stage: LocalOperationStage;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  reconciledAt: number | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  items: JournalItem[];
}

export interface WorkspaceJournalStorage {
  get(key: string): Promise<unknown>;
  list(): Promise<unknown[]>;
  put(group: JournalGroup): Promise<void>;
  compareAndSwap(group: JournalGroup, owner: string, now: number): Promise<boolean>;
  delete(key: string): Promise<void>;
  claim(key: string, owner: string, now: number, until: number): Promise<boolean>;
}

function isJournalGroup(value: unknown): value is JournalGroup {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const group = value as Record<string, unknown>;
  const groupKeys = new Set([
    'revision',
    'key',
    'id',
    'actorId',
    'teamId',
    'kind',
    'destination',
    'state',
    'stage',
    'attempt',
    'createdAt',
    'updatedAt',
    'reconciledAt',
    'leaseOwner',
    'leaseUntil',
    'items'
  ]);
  if (
    Object.keys(group).some(key => !groupKeys.has(key)) ||
    (group.revision !== undefined &&
      (!Number.isSafeInteger(group.revision) || Number(group.revision) < 0)) ||
    typeof group.key !== 'string' ||
    typeof group.id !== 'string' ||
    typeof group.actorId !== 'string' ||
    typeof group.teamId !== 'string' ||
    !['upload', 'move', 'sync'].includes(String(group.kind)) ||
    !isLocalOperationState(group.state) ||
    !isLocalOperationStage(group.stage) ||
    !Number.isSafeInteger(group.attempt) ||
    Number(group.attempt) < 1 ||
    !Number.isSafeInteger(group.createdAt) ||
    !Number.isSafeInteger(group.updatedAt) ||
    (group.reconciledAt !== null && !Number.isSafeInteger(group.reconciledAt)) ||
    (group.leaseUntil !== null && !Number.isSafeInteger(group.leaseUntil)) ||
    (group.leaseOwner !== null && typeof group.leaseOwner !== 'string') ||
    !Array.isArray(group.items) ||
    typeof group.destination !== 'object' ||
    group.destination === null
  )
    return false;
  const destination = group.destination as Record<string, unknown>;
  if (
    Object.keys(destination).some(key => !['driveFolderId', 'materialId'].includes(key)) ||
    (destination.driveFolderId !== null && typeof destination.driveFolderId !== 'string') ||
    (destination.materialId !== null && typeof destination.materialId !== 'string') ||
    group.key !== `${group.actorId}\u0000${group.id}`
  )
    return false;
  return group.items.every(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return (
      Object.keys(entry).every(key =>
        [
          'clientItemKey',
          'kind',
          'relativePath',
          'parentKey',
          'name',
          'sizeBytes',
          'state',
          'errorCode',
          'operationId',
          'resultMaterialId',
          'resultFolderId',
          'idempotencyKey'
        ].includes(key)
      ) &&
      typeof entry.clientItemKey === 'string' &&
      (entry.kind === 'file' || entry.kind === 'directory') &&
      isLocalManifestRelativePath(entry.relativePath) &&
      typeof entry.name === 'string' &&
      (entry.parentKey === null || typeof entry.parentKey === 'string') &&
      Number.isSafeInteger(entry.sizeBytes) &&
      Number(entry.sizeBytes) >= 0 &&
      isLocalItemState(entry.state) &&
      typeof entry.idempotencyKey === 'string' &&
      (entry.errorCode === null || typeof entry.errorCode === 'string') &&
      (entry.operationId === null || typeof entry.operationId === 'string') &&
      (entry.resultMaterialId === null || typeof entry.resultMaterialId === 'string') &&
      (entry.resultFolderId === null || typeof entry.resultFolderId === 'string')
    );
  });
}

/** Test adapter; production uses IndexedDB by default. */
export class MemoryWorkspaceJournalStorage implements WorkspaceJournalStorage {
  #records = new Map<string, JournalGroup>();
  async get(key: string): Promise<unknown> {
    return this.#records.get(key);
  }
  async list(): Promise<unknown[]> {
    return [...this.#records.values()];
  }
  async put(group: JournalGroup): Promise<void> {
    this.#records.set(group.key, structuredClone(group));
  }
  async compareAndSwap(group: JournalGroup, owner: string, now: number): Promise<boolean> {
    const current = this.#records.get(group.key);
    if (!canWrite(current, group, owner, now)) return false;
    this.#records.set(group.key, nextRecord(current!, group));
    return true;
  }
  async delete(key: string): Promise<void> {
    this.#records.delete(key);
  }
  async claim(key: string, owner: string, now: number, until: number): Promise<boolean> {
    const group = this.#records.get(key);
    if (
      !group ||
      (group.leaseOwner &&
        group.leaseOwner !== owner &&
        group.leaseUntil !== null &&
        group.leaseUntil > now)
    )
      return false;
    if (group.leaseOwner !== owner) group.revision = (group.revision ?? 0) + 1;
    group.leaseOwner = owner;
    group.leaseUntil = until;
    this.#records.set(key, structuredClone(group));
    return true;
  }
}

function canWrite(
  current: unknown,
  next: JournalGroup,
  owner: string,
  now: number
): current is JournalGroup {
  return (
    isJournalGroup(current) &&
    current.leaseOwner === owner &&
    (current.leaseUntil ?? 0) > now &&
    (current.revision ?? 0) === (next.revision ?? 0)
  );
}

function nextRecord(current: JournalGroup, next: JournalGroup): JournalGroup {
  return structuredClone({
    ...next,
    revision: (current.revision ?? 0) + 1,
    leaseUntil: next.leaseOwner === null ? null : current.leaseUntil
  });
}

class IndexedDBWorkspaceJournalStorage implements WorkspaceJournalStorage {
  #database: Promise<IDBDatabase>;
  constructor() {
    this.#database = new Promise((resolve, reject) => {
      const request = indexedDB.open('soty-workspace-operations', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('groups', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async get(key: string): Promise<unknown> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const request = db.transaction('groups').objectStore('groups').get(key);
      request.onsuccess = () => resolve(request.result as unknown);
      request.onerror = () => reject(request.error);
    });
  }
  async list(): Promise<unknown[]> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const request = db.transaction('groups').objectStore('groups').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
  }
  async put(group: JournalGroup): Promise<void> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('groups', 'readwrite');
      transaction.objectStore('groups').put(group);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  async compareAndSwap(group: JournalGroup, owner: string, now: number): Promise<boolean> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('groups', 'readwrite');
      const store = transaction.objectStore('groups');
      const request = store.get(group.key);
      let saved = false;
      request.onsuccess = () => {
        const current: unknown = request.result;
        if (!canWrite(current, group, owner, now)) return;
        store.put(nextRecord(current, group));
        saved = true;
      };
      transaction.oncomplete = () => resolve(saved);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  async delete(key: string): Promise<void> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('groups', 'readwrite');
      transaction.objectStore('groups').delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  async claim(key: string, owner: string, now: number, until: number): Promise<boolean> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('groups', 'readwrite');
      const request = transaction.objectStore('groups').get(key);
      let claimed = false;
      request.onsuccess = () => {
        const group: unknown = request.result;
        if (
          !isJournalGroup(group) ||
          (group.leaseOwner &&
            group.leaseOwner !== owner &&
            group.leaseUntil !== null &&
            group.leaseUntil > now)
        )
          return;
        if (group.leaseOwner !== owner) group.revision = (group.revision ?? 0) + 1;
        group.leaseOwner = owner;
        group.leaseUntil = until;
        transaction.objectStore('groups').put(group);
        claimed = true;
      };
      transaction.oncomplete = () => resolve(claimed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}

export class WorkspaceOperationJournal {
  #session = new Map<string, JournalGroup>();
  #sessionOnly = false;
  readonly #actorId: string;
  readonly #storage: WorkspaceJournalStorage;
  readonly #ownerId: string;
  readonly #now: () => number;

  constructor(input: {
    actorId: string;
    storage?: WorkspaceJournalStorage;
    ownerId?: string;
    now?: () => number;
  }) {
    this.#actorId = input.actorId;
    this.#storage = input.storage ?? new IndexedDBWorkspaceJournalStorage();
    this.#ownerId = input.ownerId ?? crypto.randomUUID();
    this.#now = input.now ?? (() => Date.now());
  }

  sessionOnly(): boolean {
    return this.#sessionOnly;
  }
  #key(id: string): string {
    return `${this.#actorId}\u0000${id}`;
  }

  async #save(group: JournalGroup): Promise<void> {
    if (!this.#sessionOnly) {
      // A rejected CAS is an ownership/version conflict, never a quota fallback.
      const saved = await this.#storage.compareAndSwap(group, this.#ownerId, this.#now());
      if (!saved) throw new Error('LOCAL_OPERATION_OWNED');
      return;
    }
    const current = this.#session.get(group.key);
    if (!canWrite(current, group, this.#ownerId, this.#now()))
      throw new Error('LOCAL_OPERATION_OWNED');
    this.#session.set(group.key, nextRecord(current, group));
  }

  async #get(id: string): Promise<JournalGroup> {
    const key = this.#key(id);
    const candidate = this.#sessionOnly ? this.#session.get(key) : await this.#storage.get(key);
    if (!isJournalGroup(candidate) || candidate.actorId !== this.#actorId)
      throw new Error('JOURNAL_NOT_FOUND');
    return structuredClone(candidate);
  }

  async #owned(id: string): Promise<JournalGroup> {
    const group = await this.#get(id);
    if (group.leaseOwner !== this.#ownerId || (group.leaseUntil ?? 0) <= this.#now())
      throw new Error('LOCAL_OPERATION_OWNED');
    return group;
  }

  async release(id: string): Promise<void> {
    const group = await this.#owned(id);
    group.leaseOwner = null;
    group.leaseUntil = null;
    await this.#save(group);
  }

  async accept(input: {
    id: string;
    teamId: string;
    destination: JournalGroup['destination'];
    manifest: LocalManifest;
  }): Promise<JournalGroup> {
    const at = this.#now();
    const group: JournalGroup = {
      revision: 0,
      key: this.#key(input.id),
      id: input.id,
      actorId: this.#actorId,
      teamId: input.teamId,
      kind: 'upload',
      destination: { ...input.destination },
      state: 'running',
      stage: 'preparing',
      attempt: 1,
      createdAt: at,
      updatedAt: at,
      reconciledAt: null,
      leaseOwner: this.#ownerId,
      leaseUntil: at + OWNER_LEASE_MS,
      items: input.manifest.entries.map(entry => ({
        clientItemKey: entry.clientItemKey,
        kind: entry.kind,
        relativePath: entry.relativePath,
        parentKey: entry.parentKey,
        name: entry.relativePath.split('/').at(-1)!,
        sizeBytes: entry.kind === 'file' ? entry.sizeBytes : 0,
        state: 'pending',
        errorCode: null,
        operationId: null,
        resultMaterialId: null,
        resultFolderId: null,
        idempotencyKey: crypto.randomUUID()
      }))
    };
    if (!this.#sessionOnly) {
      try {
        await this.#storage.put(group);
      } catch {
        this.#sessionOnly = true;
      }
    }
    if (this.#sessionOnly) this.#session.set(group.key, structuredClone(group));
    return structuredClone(group);
  }

  async load(teamId: string): Promise<JournalGroup[]> {
    const all = await this.#storage.list().catch(() => []);
    const records = new Map<string, JournalGroup>();
    for (const candidate of all) {
      if (
        isJournalGroup(candidate) &&
        candidate.actorId === this.#actorId &&
        candidate.teamId === teamId
      )
        records.set(candidate.key, candidate);
    }
    for (const candidate of this.#sessionOnly ? this.#session.values() : [])
      if (
        isJournalGroup(candidate) &&
        candidate.actorId === this.#actorId &&
        candidate.teamId === teamId
      )
        records.set(candidate.key, candidate);
    return [...records.values()].map(candidate => {
      const group = structuredClone(candidate);
      if (group.state === 'running' || group.state === 'preparing') {
        group.state = 'interrupted_input_required';
      }
      for (const item of group.items)
        if (item.state === 'running' || item.state === 'pending') item.state = 'input_required';
      return group;
    });
  }

  async checkpointItem(
    id: string,
    clientItemKey: string,
    patch: {
      state: LocalItemState;
      operationId?: string | null;
      resultMaterialId?: string | null;
      resultFolderId?: string | null;
      errorCode?: string | null;
    }
  ): Promise<JournalGroup> {
    const group = await this.#owned(id);
    const item = group.items.find(candidate => candidate.clientItemKey === clientItemKey);
    if (!item) throw new Error('JOURNAL_ITEM_NOT_FOUND');
    item.state = patch.state;
    if (patch.operationId !== undefined) item.operationId = patch.operationId;
    if (patch.resultMaterialId !== undefined) item.resultMaterialId = patch.resultMaterialId;
    if (patch.resultFolderId !== undefined) item.resultFolderId = patch.resultFolderId;
    if (patch.errorCode !== undefined) item.errorCode = patch.errorCode;
    group.updatedAt = this.#now();
    group.reconciledAt = null;
    await this.#save(group);
    return group;
  }

  async checkpointGroup(
    id: string,
    patch: { state: LocalOperationState; stage: LocalOperationStage }
  ): Promise<JournalGroup> {
    const group = await this.#owned(id);
    group.state = patch.state;
    group.stage = patch.stage;
    group.updatedAt = this.#now();
    await this.#save(group);
    return group;
  }

  async reconcile(
    id: string,
    probe: (
      operationIds: string[]
    ) => Promise<
      ReadonlyMap<
        string,
        { state: 'succeeded' | 'failed' | 'canceled' | 'running'; resultMaterialId?: string }
      >
    >
  ): Promise<JournalGroup> {
    const group = await this.#owned(id);
    const ids = [
      ...new Set(
        group.items.map(item => item.operationId).filter((value): value is string => value !== null)
      )
    ];
    const found = ids.length ? await probe(ids) : new Map();
    let allTerminal = true;
    for (const item of group.items) {
      if (!item.operationId) continue;
      const result = found.get(item.operationId);
      if (!result || result.state === 'running') {
        allTerminal = false;
        continue;
      }
      item.state = result.state;
      if (result.state === 'succeeded') item.resultMaterialId = result.resultMaterialId ?? null;
    }
    group.reconciledAt = allTerminal ? this.#now() : null;
    group.updatedAt = this.#now();
    await this.#save(group);
    return group;
  }

  async beginRetry(id: string, input: { confirmed: boolean }): Promise<JournalGroup> {
    if (!input.confirmed) throw new Error('RESELECTION_REQUIRED');
    const group = await this.#owned(id);
    if (group.items.some(item => item.operationId) && group.reconciledAt === null)
      throw new Error('RECONCILE_REQUIRED');
    group.attempt += 1;
    group.state = 'running';
    group.stage = 'preparing';
    group.reconciledAt = null;
    group.updatedAt = this.#now();
    for (const item of group.items) {
      if (item.state === 'succeeded') continue;
      item.state = 'pending';
      item.errorCode = null;
      item.operationId = null;
      item.resultMaterialId = null;
      item.resultFolderId = null;
      if (item.kind === 'file') item.idempotencyKey = crypto.randomUUID();
    }
    await this.#save(group);
    return group;
  }

  async claim(id: string): Promise<boolean> {
    const at = this.#now();
    const key = this.#key(id);
    if (!this.#sessionOnly) {
      try {
        const claimed = await this.#storage.claim(key, this.#ownerId, at, at + OWNER_LEASE_MS);
        if (claimed) {
          const group = this.#session.get(key);
          if (group) {
            group.leaseOwner = this.#ownerId;
            group.leaseUntil = at + OWNER_LEASE_MS;
          }
        }
        return claimed;
      } catch {
        return false;
      }
    }
    const group = this.#session.get(key);
    if (
      !group ||
      (group.leaseOwner &&
        group.leaseOwner !== this.#ownerId &&
        group.leaseUntil !== null &&
        group.leaseUntil > at)
    )
      return false;
    group.leaseOwner = this.#ownerId;
    group.leaseUntil = at + OWNER_LEASE_MS;
    this.#session.set(key, group);
    return true;
  }

  async purgeActor(): Promise<void> {
    for (const candidate of await this.#storage.list().catch(() => []))
      if (isJournalGroup(candidate) && candidate.actorId === this.#actorId)
        await this.#storage.delete(candidate.key);
    this.#session.clear();
  }

  async sweep(): Promise<void> {
    const at = this.#now();
    for (const candidate of await this.#storage.list().catch(() => [])) {
      if (!isJournalGroup(candidate) || candidate.actorId !== this.#actorId) continue;
      const terminal = ['succeeded', 'failed', 'partial', 'canceled'].includes(candidate.state);
      const limit = terminal ? TERMINAL_RETENTION_MS : INTERRUPTED_RETENTION_MS;
      if (at - candidate.updatedAt > limit) {
        await this.#storage.delete(candidate.key);
        this.#session.delete(candidate.key);
      }
    }
  }
}
