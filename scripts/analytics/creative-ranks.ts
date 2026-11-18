import { query } from './db.js';
import { isLaunchUuid } from '../../packages/shared/src/team/launches.js';

/**
 * 059 — why a creative has the rank it has.
 *
 * Reads the launch ledger and the rank projection (both granted to the read-only role). Every
 * credited launch is a ledger row keyed by its source: a Launch (its first successful generation)
 * or a catalog made from the video. A catalog a Launch made is `absorbed` — counted once, through
 * the Launch. Nothing here names a file, a link or a person beyond opaque ids.
 */
export interface CreativeRankDiagnosis {
  supported: boolean;
  /** What the id turned out to be. */
  matched: 'material' | 'team' | 'launch' | 'catalog' | 'none';
  ranks: {
    team_id: string;
    material_id: string;
    launch_count: number;
    rank_credit: number;
    last_launched_at: string | null;
    demoted: { reason: string; at: string } | null;
  }[];
  events: {
    material_id: string;
    source_kind: 'launch' | 'catalog';
    source_id: string;
    occurred_at: string;
    /**
     * credited = this row added +1. paired = a Launch and the catalog it made are one launch:
     * the pair's single +1 lives on the other row (`absorbed_by_launch_id` names the Launch).
     */
    effect: 'credited' | 'paired';
    absorbed_by_launch_id: string | null;
    backfilled: boolean;
  }[];
  truncated: boolean;
  explanation: string[];
  blind_spots: string[];
}

const BLIND_SPOTS = [
  'Soty does not see Facebook: a credited launch proves a successful generation or a created catalog, not a live ad. The owner corrects that with the "never launched" demotion.',
  'A Launch with no ledger row has not reached its first successful generation; read it with `npm run analytics -- launch <launch-id>`.'
];

async function supported(): Promise<boolean> {
  const rows = await query<{ name: string }>(
    `select table_name::text as name from information_schema.tables
      where table_schema = 'public' and table_name = any($1::text[])`,
    [['team_creative_launch_events', 'team_creative_ranks']]
  );
  return rows.length === 2;
}

export async function getCreativeRankDiagnosis(id: string): Promise<CreativeRankDiagnosis> {
  const result: CreativeRankDiagnosis = {
    supported: await supported(),
    matched: 'none',
    ranks: [],
    events: [],
    truncated: false,
    explanation: [],
    blind_spots: [...BLIND_SPOTS]
  };
  if (!result.supported) {
    result.blind_spots.unshift(
      'Creative ranks are not installed in this database (migration 059).'
    );
    return result;
  }
  if (!isLaunchUuid(id)) {
    result.explanation.push('The id is not a UUID; nothing was read.');
    return result;
  }

  // A launch or catalog id resolves to the creative it credited.
  const source = await query<{ material_id: string; source_kind: string }>(
    `select material_id::text, source_kind from public.team_creative_launch_events
      where source_id = $1::uuid limit 1`,
    [id]
  );
  const scope = { value: source[0] ? source[0].material_id : id };
  if (source[0]) result.matched = source[0].source_kind === 'launch' ? 'launch' : 'catalog';

  const byMaterial = await query<Record<string, unknown>>(
    `select team_id::text, material_id::text, launch_count, rank_credit, last_launched_at::text,
            demote_reason, demoted_at::text
       from public.team_creative_ranks where material_id = $1::uuid
      order by team_id limit 101`,
    [scope.value]
  );
  let ranks = byMaterial;
  if (ranks.length === 0 && !source[0]) {
    ranks = await query<Record<string, unknown>>(
      `select team_id::text, material_id::text, launch_count, rank_credit, last_launched_at::text,
              demote_reason, demoted_at::text
         from public.team_creative_ranks where team_id = $1::uuid
        order by launch_count desc, material_id limit 101`,
      [id]
    );
    if (ranks.length > 0) result.matched = 'team';
  } else if (!source[0] && ranks.length > 0) {
    result.matched = 'material';
  }
  result.truncated = ranks.length > 100;
  for (const r of ranks.slice(0, 100)) {
    result.ranks.push({
      team_id: String(r.team_id),
      material_id: String(r.material_id),
      launch_count: Number(r.launch_count),
      rank_credit: Number(r.rank_credit),
      last_launched_at: typeof r.last_launched_at === 'string' ? r.last_launched_at : null,
      demoted:
        typeof r.demote_reason === 'string' && typeof r.demoted_at === 'string'
          ? { reason: r.demote_reason, at: r.demoted_at }
          : null
    });
  }

  if (
    result.matched === 'material' ||
    result.matched === 'launch' ||
    result.matched === 'catalog'
  ) {
    const events = await query<Record<string, unknown>>(
      `select material_id::text, source_kind, source_id::text, occurred_at::text, counted,
              absorbed_by_launch_id::text, backfilled
         from public.team_creative_launch_events where material_id = $1::uuid
        order by occurred_at desc, id desc limit 101`,
      [scope.value]
    );
    result.truncated ||= events.length > 100;
    for (const e of events.slice(0, 100)) {
      const kind = e.source_kind === 'catalog' ? 'catalog' : 'launch';
      result.events.push({
        material_id: String(e.material_id),
        source_kind: kind,
        source_id: String(e.source_id),
        occurred_at: String(e.occurred_at),
        effect: e.counted === true ? 'credited' : 'paired',
        absorbed_by_launch_id:
          typeof e.absorbed_by_launch_id === 'string' ? e.absorbed_by_launch_id : null,
        backfilled: e.backfilled === true
      });
    }
    const rank = result.ranks[0];
    if (rank) {
      const credited = result.events.filter(e => e.effect === 'credited').length;
      result.explanation.push(
        `${rank.launch_count} launch(es): ${credited} credited ledger row(s) shown, ` +
          `${result.events.length - credited} paired row(s) — a Launch and the catalog it made count once.`
      );
      if (rank.rank_credit < rank.launch_count) {
        result.explanation.push(
          rank.demoted
            ? `League credit ${rank.rank_credit} is below the count because the owner demoted it (${rank.demoted.reason}) and later launches added to that.`
            : `League credit ${rank.rank_credit} is below the count.`
        );
      }
    }
  }
  if (result.matched === 'none') {
    result.explanation.push(
      'No rank, ledger row or team matched: a video never launched has no row (it shows as wax), and a Launch appears only after its first successful generation.'
    );
  }
  return result;
}
