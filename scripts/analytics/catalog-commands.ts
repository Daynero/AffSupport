import { query } from './db.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
interface CommandEvidenceRow {
  command_id: string;
  team_id: string;
  actor_id: string;
  kind: 'run' | 'retry';
  source_attempt_id: string | null;
  created_at: string;
  status: 'accepted' | 'cancelled';
  catalog_id: string;
  attempt_id: string | null;
  accepted: boolean;
  reason: string;
}
/** Immutable acceptance is separate from provider verification and visible browser delivery. */
export async function getCatalogCommandEvidence(
  id: string,
  asOf?: string,
  flowIds: string[] = [],
  limit = 100
) {
  const candidates = [...new Set([id, ...flowIds].filter(value => UUID.test(value)))];
  const maximum = Math.min(500, Math.max(1, Math.floor(limit) || 100));
  const available = await query<{
    present: boolean;
  }>(`select count(*)=2 as present from information_schema.views
    where table_schema='public' and table_name in ('analytics_catalog_commands','analytics_catalog_command_bindings')`);
  const supported = available[0]?.present === true;
  const rows =
    supported && candidates.length
      ? await query<CommandEvidenceRow>(
          `select command_id,team_id,actor_id,kind,source_attempt_id,created_at,status,
       catalog_id,attempt_id,accepted,reason from public.analytics_catalog_commands
     where (command_id=any($1::uuid[]) or command_id in (
       select command_id from public.analytics_catalog_command_bindings where attempt_id=$2::uuid))
       and created_at <= $3::timestamptz order by created_at desc,command_id,catalog_id limit $4`,
          [
            candidates.slice(0, 10),
            UUID.test(id) ? id : null,
            asOf ?? '9999-12-31T23:59:59Z',
            maximum + 1
          ]
        )
      : [];
  return {
    supported,
    items: rows.slice(0, maximum),
    truncated: rows.length > maximum || candidates.length > 10,
    item_limit: maximum,
    blind_spots: [
      ...(supported ? [] : ['Catalog command acceptance projection is unavailable.']),
      'Acceptance binds an exact request to its attempts; it does not prove provider output or browser visibility.',
      'Without other proof a missing receipt remains unknown: an in-flight request may still commit. Closing the manager does not cancel it.',
      ...(rows.length > maximum
        ? [
            'Per-item receipts were truncated; inspect the command or exact attempt with a larger bounded limit.'
          ]
        : [])
    ]
  };
}
export type CatalogCommandEvidence = Awaited<ReturnType<typeof getCatalogCommandEvidence>>;
