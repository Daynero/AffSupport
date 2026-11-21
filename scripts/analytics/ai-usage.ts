import { query } from './db.js';
import type { ResolvedPeriod } from './types.js';

/**
 * 063 — what calling Claude costs and how translation goes, for the owner's question "скільки
 * коштує переклад і чи він працює", without opening the Console or the database.
 *
 * Reads the aggregate views granted to the read-only role. Users appear only as opaque ids;
 * no transcript, translation or fingerprint is ever selected.
 */
export interface AiUsageReport {
  supported: boolean;
  cost: {
    total_usd: number;
    calls: number;
    by_model: {
      model: string;
      calls: number;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
    }[];
    by_outcome: { outcome: string; calls: number }[];
    by_day: { day: string; calls: number; cost_usd: number }[];
  };
  translations: {
    total: number;
    by_status: { status: string; count: number }[];
    failures: { code: string; count: number }[];
    by_language: { target_language: string; count: number }[];
    by_scope: { scope: string; count: number }[];
    escalated_to_sonnet: number;
    duration_ms: { p50: number | null; p95: number | null };
    minutes_translated: number;
  };
  allowance: {
    top_users: { user_id: string; spent_minutes: number; days: number }[];
    users_at_limit: number;
  };
  explanation: string[];
  blind_spots: string[];
}

const VIEWS = [
  'analytics_ai_usage_daily',
  'analytics_transcript_translations',
  'analytics_ai_allowance_daily'
];

const BLIND_SPOTS = [
  'Cost is computed by the function from token counts and the published price list; the Claude Console invoice is the authority.',
  'A translation the browser never opened is still counted as completed: completion is the server writing it, not a person reading it.'
];

const MICRO = 1_000_000;
const UNITS_PER_MINUTE = 900;

function window(period: ResolvedPeriod, column: string): { sql: string; params: unknown[] } {
  return period.start
    ? {
        sql: `${column} >= $1::timestamptz and ${column} <= $2::timestamptz`,
        params: [period.start, period.end]
      }
    : { sql: `${column} <= $1::timestamptz`, params: [period.end] };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getAiUsage(period: ResolvedPeriod): Promise<AiUsageReport> {
  const present = await query<{ name: string }>(
    `select table_name::text as name from information_schema.views
      where table_schema = 'public' and table_name = any($1::text[])`,
    [VIEWS]
  );
  const report: AiUsageReport = {
    supported: present.length === VIEWS.length,
    cost: { total_usd: 0, calls: 0, by_model: [], by_outcome: [], by_day: [] },
    translations: {
      total: 0,
      by_status: [],
      failures: [],
      by_language: [],
      by_scope: [],
      escalated_to_sonnet: 0,
      duration_ms: { p50: null, p95: null },
      minutes_translated: 0
    },
    allowance: { top_users: [], users_at_limit: 0 },
    explanation: [],
    blind_spots: [...BLIND_SPOTS]
  };
  if (!report.supported) {
    report.blind_spots.unshift(
      'Claude usage views are not installed in this database (migrations 063): the feature reports nothing yet.'
    );
    return report;
  }

  const day = window(period, 'day::timestamptz');
  const models = await query<Record<string, unknown>>(
    `select model, sum(calls)::bigint as calls, sum(cost_micro_usd)::bigint as cost,
            sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens
       from public.analytics_ai_usage_daily where ${day.sql}
      group by model order by cost desc`,
    day.params
  );
  report.cost.by_model = models.map(row => ({
    model: String(row.model),
    calls: number(row.calls),
    cost_usd: number(row.cost) / MICRO,
    input_tokens: number(row.input_tokens),
    output_tokens: number(row.output_tokens)
  }));
  report.cost.calls = report.cost.by_model.reduce((sum, row) => sum + row.calls, 0);
  report.cost.total_usd =
    Math.round(report.cost.by_model.reduce((sum, row) => sum + row.cost_usd, 0) * MICRO) / MICRO;
  const outcomes = await query<Record<string, unknown>>(
    `select outcome, sum(calls)::bigint as calls from public.analytics_ai_usage_daily
      where ${day.sql} group by outcome order by calls desc`,
    day.params
  );
  report.cost.by_outcome = outcomes.map(row => ({
    outcome: String(row.outcome),
    calls: number(row.calls)
  }));
  const days = await query<Record<string, unknown>>(
    `select to_char(day, 'YYYY-MM-DD') as day, sum(calls)::bigint as calls, sum(cost_micro_usd)::bigint as cost
       from public.analytics_ai_usage_daily where ${day.sql} group by day order by day`,
    day.params
  );
  report.cost.by_day = days.map(row => ({
    day: String(row.day),
    calls: number(row.calls),
    cost_usd: number(row.cost) / MICRO
  }));

  const created = window(period, 'created_at');
  const group = async (column: string) =>
    query<Record<string, unknown>>(
      `select ${column} as key, count(*)::bigint as count from public.analytics_transcript_translations
        where ${created.sql} group by ${column} order by count desc`,
      created.params
    );
  report.translations.by_status = (await group('status')).map(row => ({
    status: String(row.key),
    count: number(row.count)
  }));
  report.translations.total = report.translations.by_status.reduce(
    (sum, row) => sum + row.count,
    0
  );
  report.translations.by_language = (await group('target_language')).map(row => ({
    target_language: String(row.key),
    count: number(row.count)
  }));
  report.translations.by_scope = (await group('scope')).map(row => ({
    scope: String(row.key),
    count: number(row.count)
  }));
  const failures = await query<Record<string, unknown>>(
    `select failure_code as key, count(*)::bigint as count from public.analytics_transcript_translations
      where ${created.sql} and status = 'failed' group by failure_code order by count desc`,
    created.params
  );
  report.translations.failures = failures.map(row => ({
    code: String(row.key),
    count: number(row.count)
  }));
  const finished = await query<Record<string, unknown>>(
    `select percentile_cont(0.5) within group (order by duration_ms) as p50,
            percentile_cont(0.95) within group (order by duration_ms) as p95,
            coalesce(sum(units), 0)::bigint as units,
            count(*) filter (where model = 'claude-sonnet-5-5')::bigint as escalated
       from public.analytics_transcript_translations
      where ${created.sql} and status = 'completed'`,
    created.params
  );
  const totals = finished[0] ?? {};
  report.translations.duration_ms = {
    p50: totals.p50 === null || totals.p50 === undefined ? null : Math.round(number(totals.p50)),
    p95: totals.p95 === null || totals.p95 === undefined ? null : Math.round(number(totals.p95))
  };
  report.translations.minutes_translated =
    Math.round((number(totals.units) / UNITS_PER_MINUTE) * 10) / 10;
  report.translations.escalated_to_sonnet = number(totals.escalated);

  const allowance = await query<Record<string, unknown>>(
    `select user_id::text as user_id, coalesce(sum(spent_units), 0)::bigint as spent,
            count(*)::bigint as days,
            count(*) filter (where coalesce(spent_units, 0) >= limit_units)::bigint as at_limit
       from public.analytics_ai_allowance_daily where ${day.sql}
      group by user_id order by spent desc limit 10`,
    day.params
  );
  report.allowance.top_users = allowance.map(row => ({
    user_id: String(row.user_id),
    spent_minutes: Math.round((number(row.spent) / UNITS_PER_MINUTE) * 10) / 10,
    days: number(row.days)
  }));
  report.allowance.users_at_limit = allowance.filter(row => number(row.at_limit) > 0).length;

  const refused =
    report.translations.failures.find(row => row.code === 'TRANSLATION_REFUSED')?.count ?? 0;
  report.explanation.push(
    `${report.translations.total} translation attempts, ${report.cost.calls} model calls, $${report.cost.total_usd.toFixed(4)} in ${period.label}.`
  );
  if (refused > 0) {
    report.explanation.push(
      `${refused} attempts were declined by both models; their minutes were returned. Read the creative, not the code: a refusal is a content decision.`
    );
  }
  if (report.translations.escalated_to_sonnet > 0) {
    report.explanation.push(
      `${report.translations.escalated_to_sonnet} translations finished on Sonnet 5.5 after Haiku 5.5 declined a chunk.`
    );
  }
  return report;
}
