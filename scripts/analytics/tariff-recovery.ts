import { query } from './db.js';
import { getSchema } from './schema.js';
import { RECOVERY_REASONS, type RecoveryReason } from '../../packages/shared/src/team/recovery.js';
import type { InspectFound } from './types.js';
export interface RecoveryEvidence {
  recovery_id: string;
  item_id: string;
  kind: string;
  state: string;
  stage: string;
  reason: RecoveryReason | null;
  registered_at: string;
  updated_at: string;
  operation_id: string | null;
  attempt_id: string | null;
  delivery: 'confirmed' | 'unknown';
}
export interface RecoveryEvidenceResult {
  supported: boolean;
  items: RecoveryEvidence[];
  blind_spots: string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STAGES = ['registered', 'queued', 'claimed', 'started', 'terminal', 'delivered'];
export async function getRecoveryEvidence(
  id: string | null,
  since: string | null,
  asOf: string
): Promise<RecoveryEvidenceResult> {
  const schema = await getSchema();
  if (!schema.tables.analytics_workspace_recovery)
    return {
      supported: false,
      items: [],
      blind_spots: [
        'Workspace recovery projection is unavailable; missing signals do not prove successful recovery.'
      ]
    };
  if (id !== null && !UUID.test(id)) return { supported: true, items: [], blind_spots: [] };
  const rows = await query<Record<string, unknown>>(
    `select recovery_id::text,item_id::text,kind,state,stage,reason_code,registered_at::text,updated_at::text,
 operation_id::text,attempt_id::text,delivered_at::text from public.analytics_workspace_recovery
 where ($1::uuid is null or recovery_id=$1::uuid or item_id=$1::uuid or operation_id=$1::uuid or attempt_id=$1::uuid or actor_id=$1::uuid or team_id=$1::uuid or $1::uuid=any(member_ids))
 and ($2::timestamptz is null or registered_at >= $2::timestamptz) and registered_at <= $3::timestamptz and updated_at <= $3::timestamptz
 order by registered_at desc,item_id limit 101`,
    [id, since, asOf]
  );
  const items: RecoveryEvidence[] = [];
  let malformed = false;
  for (const row of rows.slice(0, 100)) {
    if (
      typeof row.recovery_id !== 'string' ||
      !UUID.test(row.recovery_id) ||
      typeof row.item_id !== 'string' ||
      !UUID.test(row.item_id) ||
      ![
        'catalog_schedule',
        'catalog_round',
        'sync',
        'restitch',
        'preview',
        'archive',
        'cleanup',
        'agent_operation'
      ].includes(String(row.kind)) ||
      ![
        'pending',
        'leased',
        'waiting_dependency',
        'resumed',
        'completed',
        'skipped_manual',
        'blocked',
        'superseded'
      ].includes(String(row.state)) ||
      !STAGES.includes(String(row.stage)) ||
      typeof row.registered_at !== 'string' ||
      !Number.isFinite(Date.parse(row.registered_at)) ||
      typeof row.updated_at !== 'string' ||
      !Number.isFinite(Date.parse(row.updated_at)) ||
      [row.operation_id, row.attempt_id].some(
        v => v !== null && (typeof v !== 'string' || !UUID.test(v))
      )
    ) {
      malformed = true;
      continue;
    }
    const reason =
      row.reason_code === null
        ? null
        : (RECOVERY_REASONS.find(reason => reason === row.reason_code) ?? 'unknown');
    if (reason === 'unknown') malformed = true;
    items.push({
      recovery_id: row.recovery_id,
      item_id: row.item_id,
      kind: String(row.kind),
      state: String(row.state),
      stage: String(row.stage),
      reason,
      registered_at: new Date(row.registered_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      operation_id: typeof row.operation_id === 'string' ? row.operation_id : null,
      attempt_id: typeof row.attempt_id === 'string' ? row.attempt_id : null,
      delivery:
        typeof row.delivered_at === 'string' && Number.isFinite(Date.parse(row.delivered_at))
          ? 'confirmed'
          : 'unknown'
    });
  }
  return {
    supported: true,
    items,
    blind_spots: [
      ...(items.some(item => item.delivery === 'unknown')
        ? ['A server recovery receipt is not proof that its output reached the user.']
        : []),
      ...(rows.length > 100 ? ['Recovery evidence is truncated at 100 items.'] : []),
      ...(malformed
        ? ['An unsupported recovery row or reason was omitted or marked unknown.']
        : []),
      'Mutable rows changed after as-of are omitted rather than reconstructed as historical success.'
    ]
  };
}
export function inspectRecovery(id: string, result: RecoveryEvidenceResult): InspectFound | null {
  if (!result.items.length) return null;
  const observed = [...new Set(result.items.map(item => item.stage))];
  const expected = ['registered', 'queued', 'started', 'terminal', 'delivered'];
  const latest = [...result.items].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const settled = result.items.every(item =>
    ['completed', 'skipped_manual', 'superseded'].includes(item.state)
  );
  return {
    found: true,
    id,
    capability: 'team.tariff_recovery',
    tool: 'team',
    matched_by: ['authoritative_table'],
    stages: { expected, observed, missing: expected.filter(stage => !observed.includes(stage)) },
    terminal: settled
      ? {
          event: 'database:workspace_recovery',
          outcome: 'server_settled',
          occurred_at: latest.updated_at
        }
      : null,
    last_proven_stage: latest.stage,
    first_seen_at: result.items.at(-1)!.registered_at,
    last_seen_at: latest.updated_at,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    events: [],
    recovery: result,
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: [],
      note: 'Recovery receipts contain no device identity or user content; missing output delivery remains unknown.'
    }
  };
}
