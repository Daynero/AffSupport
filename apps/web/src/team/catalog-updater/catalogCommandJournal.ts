import { TeamApiError } from '../../api/team';
/** Pending request identities only: no names, values, URLs or credentials. */
export interface CatalogCommandIntent {
  commandId: string;
  catalogIds: string[];
  sourceAttemptId?: string;
  createdAt: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_COMMANDS = 50;
const MAX_STORAGE_KEYS = 2000;
export function validIntent(value: unknown): value is CatalogCommandIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as CatalogCommandIntent;
  return (
    UUID.test(intent.commandId) &&
    Array.isArray(intent.catalogIds) &&
    intent.catalogIds.length >= 1 &&
    intent.catalogIds.length <= 500 &&
    intent.catalogIds.every(id => typeof id === 'string' && UUID.test(id)) &&
    new Set(intent.catalogIds.map(id => id.toLowerCase())).size === intent.catalogIds.length &&
    (intent.sourceAttemptId === undefined ||
      (UUID.test(intent.sourceAttemptId) && intent.catalogIds.length === 1)) &&
    typeof intent.createdAt === 'number' &&
    Number.isSafeInteger(intent.createdAt) &&
    intent.createdAt >= 0
  );
}
function canonical(intent: CatalogCommandIntent): CatalogCommandIntent {
  return {
    commandId: intent.commandId.toLowerCase(),
    catalogIds: intent.catalogIds.map(id => id.toLowerCase()).sort(),
    createdAt: intent.createdAt,
    ...(intent.sourceAttemptId ? { sourceAttemptId: intent.sourceAttemptId.toLowerCase() } : {})
  };
}
/** Retain a private canonical copy rather than a caller-owned mutable array. */
export function normalizeCatalogCommandIntent(value: unknown): CatalogCommandIntent | null {
  return validIntent(value) ? canonical(value) : null;
}
export class CatalogCommandJournal {
  private readonly prefix: string;
  private readonly storage: Storage;
  constructor(actorId: string, teamId: string, storage: Storage) {
    this.storage = storage;
    if (!UUID.test(actorId) || !UUID.test(teamId)) throw new TeamApiError('INVALID_INPUT', false);
    this.prefix = `soty.catalog-command.v1:${actorId.toLowerCase()}:${teamId.toLowerCase()}:`;
  }
  list(): CatalogCommandIntent[] {
    try {
      return this.read();
    } catch {
      throw new TeamApiError('CATALOG_COMMAND_STORAGE_UNAVAILABLE', false);
    }
  }
  private read(): CatalogCommandIntent[] {
    if (this.storage.length > MAX_STORAGE_KEYS)
      throw new TeamApiError('CATALOG_COMMAND_STORAGE_UNAVAILABLE', false);
    const intents: CatalogCommandIntent[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(this.prefix)) continue;
      const raw = this.storage.getItem(key);
      if (raw === null || raw.length > 25_000)
        throw new TeamApiError('CATALOG_COMMAND_STORAGE_UNAVAILABLE', false);
      const value: unknown = JSON.parse(raw);
      if (!validIntent(value) || key !== this.prefix + value.commandId)
        throw new TeamApiError('CATALOG_COMMAND_STORAGE_UNAVAILABLE', false);
      intents.push(canonical(value));
      if (intents.length > MAX_COMMANDS)
        throw new TeamApiError('CATALOG_COMMAND_STORAGE_UNAVAILABLE', false);
    }
    return intents.sort(
      (a, b) => a.createdAt - b.createdAt || a.commandId.localeCompare(b.commandId)
    );
  }
  put(intent: CatalogCommandIntent): void {
    if (!validIntent(intent)) throw new TeamApiError('INVALID_INPUT', false);
    intent = canonical(intent);
    const existing = this.list();
    const previous = existing.find(item => item.commandId === intent.commandId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(intent))
        throw new TeamApiError('INVALID_INPUT', false);
      return;
    }
    if (existing.length >= MAX_COMMANDS)
      throw new TeamApiError('CATALOG_COMMAND_STORAGE_UNAVAILABLE', false);
    // One key per intent: another tab cannot overwrite this tab's pending identities.
    try {
      this.storage.setItem(this.prefix + intent.commandId, JSON.stringify(intent));
    } catch {
      throw new TeamApiError('CATALOG_COMMAND_STORAGE_UNAVAILABLE', false);
    }
  }
  remove(commandId: string): void {
    if (!UUID.test(commandId)) throw new TeamApiError('INVALID_INPUT', false);
    this.storage.removeItem(this.prefix + commandId.toLowerCase());
  }
}
