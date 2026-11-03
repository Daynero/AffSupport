import type { TeamRealtimeDomain } from './useTeamRealtime';

// CHECK in 20261205121000_bulk_trash_receipts.sql. Updater/profile writers
// also emit upserted and sync_state: those cannot be narrowed without a new
// producer contract. Missing/new kinds deliberately retain every catalog read.
const catalogReads = ['catalog', 'storage', 'updater'] as const;
const domains = {
  upserted: catalogReads,
  tombstoned: catalogReads,
  restored: catalogReads,
  sync_state: catalogReads,
  folder_indexed: ['catalog', 'storage'],
  thumbnail_ready: ['catalog', 'storage'],
  storage_state: ['catalog', 'storage', 'teams'],
  bulk_trash_changed: catalogReads
} satisfies Record<string, readonly TeamRealtimeDomain[]>;

export type CatalogEventKind = keyof typeof domains;
export function catalogEventDomains(kind: unknown): readonly TeamRealtimeDomain[] {
  return typeof kind === 'string' && Object.hasOwn(domains, kind)
    ? domains[kind as CatalogEventKind]
    : catalogReads;
}
