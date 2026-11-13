import { TeamApiError } from '../../api/team';

export interface WorkspaceMutationIntent {
  id: string;
  materialIds: string[];
  createdAt: number;
}
type Action = 'bulk-trash' | 'restore' | 'catalog-rename';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const unavailable = () => new TeamApiError('CATALOG_COMMAND_STORAGE_UNAVAILABLE', false);
const canonicalIds = (ids: readonly string[]) =>
  [...new Set(ids.map(id => id.toLowerCase()))].sort();

/** Pending identities only. Unknown acceptance never expires into permission for a new write. */
export class WorkspaceMutationJournal {
  private readonly prefix: string;
  constructor(
    action: Action,
    actorId: string,
    teamId: string,
    private readonly storage: Storage
  ) {
    if (!UUID.test(actorId) || !UUID.test(teamId)) throw new TeamApiError('AUTH_REQUIRED', false);
    this.prefix = `soty.workspace-mutation.v1:${actorId.toLowerCase()}:${teamId.toLowerCase()}:${action}:`;
  }
  list(): WorkspaceMutationIntent[] {
    try {
      if (this.storage.length > 2000) throw unavailable();
      const result: WorkspaceMutationIntent[] = [];
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (!key?.startsWith(this.prefix)) continue;
        const raw = this.storage.getItem(key);
        if (raw === null || raw.length > 25000) throw unavailable();
        const value = JSON.parse(raw) as Partial<WorkspaceMutationIntent> | null;
        if (
          !value ||
          typeof value.id !== 'string' ||
          !UUID.test(value.id) ||
          key !== this.prefix + value.id ||
          !Array.isArray(value.materialIds) ||
          value.materialIds.length < 1 ||
          value.materialIds.length > 500 ||
          !value.materialIds.every(id => typeof id === 'string' && UUID.test(id)) ||
          JSON.stringify(value.materialIds) !== JSON.stringify(canonicalIds(value.materialIds)) ||
          !Number.isSafeInteger(value.createdAt) ||
          value.createdAt! < 0
        )
          throw unavailable();
        result.push({
          id: value.id,
          materialIds: [...value.materialIds],
          createdAt: value.createdAt!
        });
        if (result.length > 50) throw unavailable();
      }
      return result;
    } catch {
      throw unavailable();
    }
  }
  acquire(materialIds: readonly string[]): WorkspaceMutationIntent {
    if (
      materialIds.length < 1 ||
      materialIds.length > 500 ||
      !materialIds.every(id => UUID.test(id))
    )
      throw new TeamApiError('INVALID_INPUT', false);
    const ids = canonicalIds(materialIds);
    const pending = this.list();
    const match = pending.find(
      intent => JSON.stringify(intent.materialIds) === JSON.stringify(ids)
    );
    if (match) return match;
    if (pending.some(intent => intent.materialIds.some(id => ids.includes(id))))
      throw new TeamApiError('PROCESS_RESULT_UNCERTAIN', true);
    if (pending.length >= 50) throw unavailable();
    const intent = { id: crypto.randomUUID(), materialIds: ids, createdAt: Date.now() };
    try {
      const key = this.prefix + intent.id;
      this.storage.setItem(key, JSON.stringify(intent));
      if (this.storage.getItem(key) !== JSON.stringify(intent)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return intent;
  }
  confirmed(id: string): void {
    if (!UUID.test(id)) throw new TeamApiError('INVALID_INPUT', false);
    try {
      const key = this.prefix + id.toLowerCase();
      this.storage.removeItem(key);
      if (this.storage.getItem(key) !== null) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
}
