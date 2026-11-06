import { query } from './db.js';
import { getSchema } from './schema.js';
import type { InspectData } from './types.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATES = [
  'awaiting_selection',
  'candidate_selected',
  'candidate_rejected',
  'range_unconfirmed',
  'screen_validated'
] as const;
export interface RestitchSelectionRecord {
  operation_id: string;
  team_id: string;
  slot: 'start' | 'end';
  pool_namespace_id: string;
  state: (typeof STATES)[number];
  snapshot_complete: boolean | null;
  candidate_count: number;
  candidate_versions: string[];
  range_count: number;
  unconfirmed_range_count: number;
  confirmed_bytes: number;
  confirmed_io_ms: number;
  retry_count: number;
  refresh_count: number;
  budget_revision: number;
  created_at: string;
  updated_at: string;
}
export interface RestitchSelectionEvidence {
  supported: boolean | null;
  records: RestitchSelectionRecord[];
  blind_spots: string[];
}
const time = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9TtZz +:.-]{1,64}$/u.test(v) && Number.isFinite(Date.parse(v));
const whole = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
export async function getRestitchSelectionEvidence(input: {
  actorId?: string | null;
  ids?: readonly string[];
  since?: string | null;
  asOf: string;
}): Promise<RestitchSelectionEvidence> {
  let supported: boolean | null = null;
  try {
    const schema = await getSchema();
    supported = Boolean(schema.tables.analytics_restitch_selection_slots);
    if (!supported)
      return {
        supported: false,
        records: [],
        blind_spots: [
          'Restitch selection projection is unavailable; prior image choices and consumed budgets remain unknown.'
        ]
      };
    const actor = input.actorId && UUID.test(input.actorId) ? input.actorId.toLowerCase() : null;
    const ids = [
      ...new Set((input.ids ?? []).filter(id => UUID.test(id)).map(id => id.toLowerCase()))
    ].slice(0, 100);
    if (!actor && !ids.length) return { supported: true, records: [], blind_spots: [] };
    const rows = await query<Record<string, unknown>>(
      "select operation_id::text,team_id::text,actor_id::text,slot,pool_namespace_id::text,state,snapshot_complete,candidate_count,candidate_versions,range_count,unconfirmed_range_count,confirmed_bytes::float8,confirmed_io_ms::float8,retry_count,refresh_count,budget_revision,created_at::text,updated_at::text from public.analytics_restitch_selection_slots where ($1::uuid is null or actor_id=$1::uuid) and ($2::uuid[] is null or operation_id=any($2::uuid[])) and ($3::timestamptz is null or updated_at >= $3::timestamptz or state='range_unconfirmed') and updated_at <= $4::timestamptz order by updated_at desc,operation_id,slot limit 101",
      [actor, ids.length ? ids : null, input.since ?? null, input.asOf]
    );
    let malformed = false;
    const records: RestitchSelectionRecord[] = [];
    for (const r of rows.slice(0, 100)) {
      if (
        typeof r.operation_id !== 'string' ||
        !UUID.test(r.operation_id) ||
        typeof r.team_id !== 'string' ||
        !UUID.test(r.team_id) ||
        typeof r.actor_id !== 'string' ||
        !UUID.test(r.actor_id) ||
        (actor && r.actor_id !== actor) ||
        (ids.length && !ids.includes(r.operation_id)) ||
        typeof r.pool_namespace_id !== 'string' ||
        !UUID.test(r.pool_namespace_id) ||
        typeof r.slot !== 'string' ||
        !['start', 'end'].includes(r.slot) ||
        !STATES.includes(r.state as (typeof STATES)[number]) ||
        (r.snapshot_complete !== null && typeof r.snapshot_complete !== 'boolean') ||
        !whole(r.candidate_count, 32) ||
        !whole(r.range_count, 956) ||
        !whole(r.unconfirmed_range_count, 1) ||
        Number(r.unconfirmed_range_count) > Number(r.range_count) ||
        !whole(r.confirmed_bytes, 262144000) ||
        !whole(r.confirmed_io_ms, Number.MAX_SAFE_INTEGER) ||
        !whole(r.retry_count, 6) ||
        !whole(r.refresh_count, 2) ||
        !whole(r.budget_revision, 2022) ||
        !time(r.created_at) ||
        !time(r.updated_at) ||
        !Array.isArray(r.candidate_versions) ||
        r.candidate_versions.length !== r.candidate_count ||
        !r.candidate_versions.every(v => typeof v === 'string' && UUID.test(v)) ||
        new Set(r.candidate_versions.map(v => String(v).toLowerCase())).size !==
          r.candidate_versions.length ||
        (r.state === 'range_unconfirmed') !== (r.unconfirmed_range_count === 1) ||
        (r.state === 'awaiting_selection' && r.candidate_count !== 0) ||
        (r.state !== 'awaiting_selection' && r.candidate_count === 0) ||
        (r.candidate_count === 0 &&
          (r.range_count !== 0 || r.refresh_count !== 0 || r.retry_count !== 0)) ||
        (r.range_count === r.unconfirmed_range_count &&
          (r.confirmed_bytes !== 0 || r.confirmed_io_ms !== 0)) ||
        (r.unconfirmed_range_count === 1 &&
          (r.confirmed_bytes >= 262144000 || r.confirmed_io_ms >= 120000)) ||
        r.budget_revision <
          r.candidate_count +
            r.range_count +
            (r.range_count - r.unconfirmed_range_count) +
            r.refresh_count
      ) {
        malformed = true;
        continue;
      }
      records.push({
        operation_id: r.operation_id,
        team_id: r.team_id,
        slot: r.slot as 'start' | 'end',
        pool_namespace_id: r.pool_namespace_id,
        state: r.state as RestitchSelectionRecord['state'],
        snapshot_complete: r.snapshot_complete as boolean | null,
        candidate_count: r.candidate_count,
        candidate_versions: r.candidate_versions.map(v => String(v).toLowerCase()),
        range_count: r.range_count,
        unconfirmed_range_count: r.unconfirmed_range_count,
        confirmed_bytes: r.confirmed_bytes,
        confirmed_io_ms: r.confirmed_io_ms,
        retry_count: r.retry_count,
        refresh_count: r.refresh_count,
        budget_revision: r.budget_revision,
        created_at: r.created_at,
        updated_at: r.updated_at
      });
    }
    return {
      supported: true,
      records,
      blind_spots: [
        'This is storage-only evidence. Root acceptance, protected upstream measurement and product execution are not enabled by this foundation.',
        'A reserved range proves neither upstream execution nor nonexecution. Recorded screen validation proves neither video creation nor delivery.',
        'This current-state projection omits rows changed after as-of; it does not reconstruct historical image choices.',
        'Rejection causes are not recorded in this foundation; a correlated native failure remains separate evidence.',
        ...(rows.length > 100 ? ['Restitch selection evidence truncated at100 rows.'] : []),
        ...((input.ids?.length ?? 0) > 100
          ? ['Restitch selectors truncated at100 identities.']
          : []),
        ...(malformed
          ? [
              'Malformed or contradictory restitch selection evidence was omitted; its result remains unknown.'
            ]
          : [])
      ]
    };
  } catch {
    return {
      supported,
      records: [],
      blind_spots: [
        'Restitch selection read failed; image choice, consumed budget and pending accounting remain unknown.'
      ]
    };
  }
}
export function mergeRestitchSelectionInspection(
  core: InspectData,
  evidence: RestitchSelectionEvidence
): InspectData {
  if (!evidence.records.length) {
    const relevant =
      core.found &&
      (core.events.some(e => String(e.properties.error_code ?? '').startsWith('RESTITCH_')) ||
        core.team_native?.records.some(r => r.error_code?.startsWith('RESTITCH_')));
    return relevant ? { ...core, restitch_selections: evidence } : core;
  }
  if (core.found) return { ...core, restitch_selections: evidence };
  const latest = evidence.records[0]!;
  const observed = [
    'context_observed',
    ...(latest.candidate_count ? ['candidate_recorded'] : []),
    ...(latest.range_count ? ['range_reserved'] : []),
    ...(latest.range_count > latest.unconfirmed_range_count ? ['range_accounted'] : []),
    ...(latest.state === 'screen_validated' ? ['screen_validation_recorded'] : [])
  ];
  const expected = [
    'context_observed',
    'candidate_recorded',
    'range_reserved',
    'range_accounted',
    'screen_validation_recorded',
    'video_processed',
    'result_visible'
  ];
  return {
    found: true,
    id: core.id,
    matched_by: ['authoritative_table'],
    capability: 'team.restitch_selection',
    tool: 'team',
    stages: { expected, observed, missing: expected.filter(stage => !observed.includes(stage)) },
    terminal: null,
    last_proven_stage: observed.at(-1) ?? null,
    first_seen_at: evidence.records.at(-1)?.created_at ?? null,
    last_seen_at: latest.updated_at,
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
      note: 'Storage evidence does not identify or prove native execution or delivery.'
    },
    events: [],
    restitch_selections: evidence
  };
}
