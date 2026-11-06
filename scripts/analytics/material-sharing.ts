import { query } from './db.js';
import { lookupCodeLocations } from './code-map.js';
import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';
import type { InspectFound, ResolvedPeriod } from './types.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const codes = new Set<string>(TEAM_ERROR_CODES);
const states = new Set(['write_started', 'acknowledged', 'confirmed', 'blocked']);
interface ReceiptRow {
  intent_id: string;
  team_id: string;
  actor_id: string;
  command_id: string;
  state: string;
  write_may_have_started: boolean;
  permission_acknowledged: boolean;
  created_at: string;
  confirmed_at: string | null;
  material_id: string | null;
}
interface UiRow {
  flow_id: string | null;
  event_name: string;
  flow_step: string;
  error_code: string | null;
  production_completed: boolean | null;
  occurred_at: string;
  created_at: string;
}
const iso = (value: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const unavailable = (cause: unknown) => {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
  return code === '57014'
    ? 'timeout'
    : code === '42501'
      ? 'permission'
      : typeof code === 'string' && ['42P01', '42703', '42883'].includes(code)
        ? 'schema'
        : 'unavailable';
};
/** Permission observations are not UI delivery, nor reconstructed historical state. */
export async function getMaterialSharingEvidence(
  id: string,
  asOf?: string,
  relatedIds: string[] = [],
  limit = 100
) {
  const candidates = [
    ...new Set(
      [id, ...relatedIds].filter(value => UUID.test(value)).map(value => value.toLowerCase())
    )
  ];
  const maximum = Math.min(200, Math.max(1, Math.floor(limit) || 100));
  let supported = false;
  let observedAt: string | null = null;
  const unavailableSources: string[] = [];
  try {
    const meta = await query<{
      present: boolean;
      observed_at: string;
    }>(`select exists(select 1 from information_schema.views
    where table_schema='public' and table_name='analytics_material_share_intents') present,
    clock_timestamp()::text observed_at`);
    supported = meta[0]?.present === true;
    observedAt = supported ? iso(meta[0]?.observed_at ?? null) : null;
  } catch (cause) {
    unavailableSources.push('permission_receipts:' + unavailable(cause));
  }
  const [receipts, ui] = await Promise.allSettled([
    supported && candidates.length
      ? query<ReceiptRow>(
          `select intent_id,team_id,actor_id,command_id,state,
   write_may_have_started,permission_acknowledged,created_at::text,confirmed_at::text,material_id
   from public.analytics_material_share_intents where (command_id=any($1::uuid[]) or intent_id=any($1::uuid[]))
   and created_at<=$2::timestamptz order by created_at desc,intent_id limit $3`,
          [candidates.slice(0, 10), asOf ?? '9999-12-31T23:59:59Z', maximum + 1]
        )
      : Promise.resolve([]),
    candidates.length
      ? query<UiRow>(
          `select properties->>'flow_id' flow_id,event_name,properties->>'flow_step' flow_step,
   properties->>'error_code' error_code,
   case when jsonb_typeof(properties->'production_completed')='boolean' then (properties->>'production_completed')::boolean end production_completed,
   occurred_at::text,created_at::text from public.analytics_events
   where properties ? 'parent_flow_id' and properties->>'feature_identifier'='material_link'
   and properties->>'parent_flow_id'=any($1::text[])
   and properties->>'flow_step' in ('material_link_clipboard','material_link_get_link','material_link_share','material_link_confirm','material_link_readback')
   and event_name in ('operation_started','operation_completed','operation_failed','operation_cancelled')
   and created_at<=$2::timestamptz order by created_at desc,id desc limit $3`,
          [candidates.slice(0, 10), asOf ?? '9999-12-31T23:59:59Z', maximum + 1]
        )
      : Promise.resolve([])
  ]);
  const rows = receipts.status === 'fulfilled' ? receipts.value : [];
  const childRows = ui.status === 'fulfilled' ? ui.value : [];
  if (receipts.status === 'rejected') {
    supported = false;
    unavailableSources.push('permission_receipts:' + unavailable(receipts.reason));
  }
  if (ui.status === 'rejected') unavailableSources.push('related_ui:' + unavailable(ui.reason));
  return {
    supported,
    observed_at: observedAt,
    current_snapshot: true,
    historical_state: asOf ? 'not_reconstructed' : 'not_requested',
    items: rows.slice(0, maximum).map(row => ({
      intent_id: row.intent_id,
      command_id: row.command_id,
      team_id: row.team_id,
      actor_id: row.actor_id,
      material_id: row.material_id,
      request_state: states.has(row.state) ? row.state : 'unknown',
      write_may_have_started:
        typeof row.write_may_have_started === 'boolean' ? row.write_may_have_started : null,
      permission_acknowledged:
        typeof row.permission_acknowledged === 'boolean' ? row.permission_acknowledged : null,
      created_at: iso(row.created_at),
      public_observed_at: iso(row.confirmed_at)
    })),
    related_ui_events: childRows.slice(0, maximum).map(row => {
      const code =
        typeof row.error_code === 'string' && codes.has(row.error_code)
          ? row.error_code
          : row.event_name === 'operation_failed'
            ? 'UNKNOWN'
            : null;
      return {
        flow_id: row.flow_id && UUID.test(row.flow_id) ? row.flow_id : null,
        event: row.event_name,
        flow_step: row.flow_step,
        goal_reached: row.production_completed,
        code,
        code_locations: code ? lookupCodeLocations(`team:library:${code}`) : null,
        occurred_at: iso(row.occurred_at),
        delivered_at: iso(row.created_at)
      };
    }),
    unavailable_sources: unavailableSources,
    truncated: rows.length > maximum || childRows.length > maximum || candidates.length > 10,
    item_limit: maximum,
    blind_spots: [
      ...(supported
        ? []
        : [
            'Permission receipt projection is unavailable; missing rows are not proof of no write.'
          ]),
      'A consumed permit without a valid acknowledgement does not prove provider dispatch or which writer created access.',
      'A confirmation proves a public-access observation, not current permissions, visible URL or clipboard delivery.',
      'Completed receipts retain request binding without historical material or provider pointers. Expired completed evidence is not reconstructed.',
      ...(asOf
        ? [
            'The cutoff bounds receipt creation only; mutable receipt state is a current snapshot. Immutable UI events are separately bounded by delivery time.'
          ]
        : []),
      'Related clipboard failures are separate from successful URL resolution; clipboard contents and use elsewhere are unobservable.'
    ]
  };
}
export type MaterialSharingEvidence = Awaited<ReturnType<typeof getMaterialSharingEvidence>>;
/** Discover server-only requests even when the browser never delivered an event. */
export async function getOwnedMaterialSharingEvidence(
  actorId: string | null,
  period: ResolvedPeriod
) {
  let commands: Array<{ command_id: string }> = [];
  let discoveryFailure: string | null = null;
  if (actorId && UUID.test(actorId)) {
    try {
      commands = await query<{ command_id: string }>(
        `select command_id from public.analytics_material_share_intents
         where actor_id=$1::uuid and ($2::timestamptz is null or created_at >= $2::timestamptz) and created_at <= $3::timestamptz
         order by created_at desc,intent_id limit 11`,
        [actorId, period.start, period.end]
      );
    } catch (cause) {
      discoveryFailure = unavailable(cause);
    }
  }
  const evidence = await getMaterialSharingEvidence(
    '',
    period.end,
    commands.slice(0, 10).map(row => row.command_id)
  );
  return {
    ...evidence,
    truncated: evidence.truncated || commands.length > 10,
    discovery_limit: 10,
    unavailable_sources: [
      ...evidence.unavailable_sources,
      ...(discoveryFailure ? ['request_discovery:' + discoveryFailure] : [])
    ],
    blind_spots: [
      ...evidence.blind_spots,
      ...(!actorId
        ? ['No user identity was resolved; server request ownership cannot be discovered.']
        : []),
      ...(discoveryFailure
        ? ['Server request discovery failed; absent requests must not be treated as no writes.']
        : []),
      ...(commands.length > 10
        ? ['Only the ten newest server requests in the period were inspected.']
        : [])
    ]
  };
}
export function inspectMaterialSharing(
  id: string,
  evidence: MaterialSharingEvidence,
  asOf?: string
): InspectFound | null {
  const latest = evidence.items[0];
  if (!latest) return null;
  const verified =
    latest.public_observed_at &&
    (!asOf || Date.parse(latest.public_observed_at) <= Date.parse(asOf));
  const observed = verified ? ['request_recorded', 'permission_observed'] : ['request_recorded'];
  return {
    found: true,
    id,
    matched_by: ['authoritative_table'],
    capability: 'team.material_sharing',
    tool: 'team',
    stages: {
      expected: ['request_recorded', 'permission_observed', 'browser_result'],
      observed,
      missing: verified ? ['browser_result'] : ['permission_observed', 'browser_result']
    },
    terminal: null,
    last_proven_stage: observed.at(-1)!,
    first_seen_at: evidence.items.at(-1)?.created_at ?? null,
    last_seen_at: verified ? latest.public_observed_at : latest.created_at,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: [],
      note: 'Server sharing evidence cannot prove a browser result or clipboard delivery.'
    },
    events: [],
    material_sharing: evidence
  };
}

/** Bounded current-state sample; never uses unrelated sync jobs as proof of sharing coverage. */
export async function getMaterialSharingAudit(period: ResolvedPeriod) {
  const rows = await query<{ samples: number; pending: number; missing_browser: number }>(
    `with bounded as (
      select command_id,state from public.analytics_material_share_intents
      where ($1::timestamptz is null or created_at >= $1::timestamptz) and created_at <= $2::timestamptz
      order by created_at desc,intent_id limit 501
    ) select count(*)::int samples,
      count(*) filter(where state in ('write_started','acknowledged','blocked'))::int pending,
      count(*) filter(where not exists(select 1 from public.analytics_events e
        where (e.flow_id=b.command_id or e.properties->>'parent_flow_id'=b.command_id::text)
        and e.properties->>'feature_identifier'='material_link'
        and e.properties->>'flow_step' in ('material_link_share','material_link_confirm','material_link_readback')
        and e.event_name='operation_completed' and e.properties->>'production_completed'='true'
        and e.created_at <= $2::timestamptz))::int missing_browser
    from bounded b`,
    [period.start, period.end]
  );
  const row = rows[0];
  if (
    !row ||
    ![row.samples, row.pending, row.missing_browser].every(
      value => Number.isSafeInteger(value) && value >= 0
    )
  )
    throw new Error('Invalid sharing audit projection');
  return { ...row, truncated: row.samples > 500, current_snapshot: true };
}
