import { query } from './db.js';
import type { ResolvedPeriod } from './types.js';

/**
 * 064 — the launch assistant and credits for an agent asking "що сталося з цією командою" or
 * "скільки коштує помічник і де він відмовляє". Reads only the projections granted to the
 * read-only role: codes, states, counts and amounts. No message, plan, card or link is selected.
 */
export interface AssistantCommandTrail {
  supported: boolean;
  command: {
    id: string;
    kind: string;
    status: string;
    reason_code: string | null;
    model: string | null;
    price: number;
    created_at: string;
    updated_at: string;
    effects: number;
    undone_effects: number;
    card_kinds: string[];
    launched_reviews: number;
  } | null;
  /** accepted → parsing → executing → done | partial | rejected | unknown | undone */
  last_proven_stage: string | null;
  model_calls: { outcome: string; input_tokens: number; output_tokens: number; cost_usd: number; created_at: string }[];
  credits: { kind: string; amount: number; kyiv_day: string; created_at: string }[];
  month_hold: { usd_upper: number; usd_actual: number | null; state: string } | null;
  findings: string[];
  blind_spots: string[];
}

export interface AssistantSummary {
  supported: boolean;
  commands: { total: number; by_status: { status: string; count: number }[]; by_reason: { reason: string; count: number }[] };
  model_calls_per_paid_command: number | null;
  credits: { debited: number; refunded: number; by_feature: { feature: string; debited: number; refunded: number }[] };
  open_holds: number;
  blind_spots: string[];
}

const BLIND_SPOTS = [
  'Whether a card reached the screen is not proven by the server; the browser trail (flow_step launch_assistant_*) is the only evidence.',
  'Generation after «Запустити N» is the batch of 053: follow it with `inspect <batch request key>` and the launch run ids.'
];

const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function installed(): Promise<boolean> {
  const rows = await query<{ count: string }>(
    `select count(*)::text as count from information_schema.views where table_schema = 'public'
      and table_name in ('analytics_assistant_commands', 'analytics_ai_credit_ledger', 'analytics_ai_month_holds')`,
    []
  );
  return n(rows[0]?.count) === 3;
}

export async function getAssistantCommand(id: string): Promise<AssistantCommandTrail> {
  const trail: AssistantCommandTrail = {
    supported: await installed(),
    command: null,
    last_proven_stage: null,
    model_calls: [],
    credits: [],
    month_hold: null,
    findings: [],
    blind_spots: [...BLIND_SPOTS]
  };
  if (!trail.supported) {
    trail.blind_spots.unshift('Assistant views are not installed in this database (migrations 064).');
    return trail;
  }
  const rows = await query<Record<string, unknown>>(
    `select id::text, kind, status, reason_code, model, price, created_at::text, updated_at::text, effects,
            undone_effects, coalesce(card_kinds, '{}') as card_kinds, launched_reviews
       from public.analytics_assistant_commands where id::text = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) {
    trail.findings.push('insufficient: no assistant command with this id (it may have expired with its conversation after 7 days).');
    return trail;
  }
  trail.command = {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    reason_code: row.reason_code === null ? null : String(row.reason_code),
    model: row.model === null ? null : String(row.model),
    price: n(row.price),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    effects: n(row.effects),
    undone_effects: n(row.undone_effects),
    card_kinds: Array.isArray(row.card_kinds) ? (row.card_kinds as unknown[]).map(String) : [],
    launched_reviews: n(row.launched_reviews)
  };
  trail.last_proven_stage = trail.command.status;
  trail.model_calls = (
    await query<Record<string, unknown>>(
      `select outcome, input_tokens, output_tokens, cost_micro_usd, created_at::text
         from public.analytics_ai_usage_events where subject_id::text = $1 order by created_at`,
      [id]
    )
  ).map(call => ({
    outcome: String(call.outcome),
    input_tokens: n(call.input_tokens),
    output_tokens: n(call.output_tokens),
    cost_usd: n(call.cost_micro_usd) / 1_000_000,
    created_at: String(call.created_at)
  }));
  const opKey = `launch_assistant:${id}`;
  trail.credits = (
    await query<Record<string, unknown>>(
      `select kind, amount, kyiv_day::text, created_at::text from public.analytics_ai_credit_ledger
        where op_key = $1 order by created_at`,
      [opKey]
    )
  ).map(entry => ({ kind: String(entry.kind), amount: n(entry.amount), kyiv_day: String(entry.kyiv_day), created_at: String(entry.created_at) }));
  const hold = (
    await query<Record<string, unknown>>(
      `select usd_upper, usd_actual, state from public.analytics_ai_month_holds where op_key = $1`,
      [opKey]
    )
  )[0];
  if (hold) trail.month_hold = { usd_upper: n(hold.usd_upper), usd_actual: hold.usd_actual === null ? null : n(hold.usd_actual), state: String(hold.state) };

  const debited = trail.credits.some(entry => entry.kind === 'debit');
  const refunded = trail.credits.some(entry => entry.kind === 'refund');
  if (trail.command.status === 'rejected' && debited && !refunded && trail.command.effects === 0)
    trail.findings.push('fact: rejected without writes but not refunded (only PLAN_TOO_LARGE-type refusals after a model call keep nothing; check the refund path).');
  if (trail.command.status === 'unknown')
    trail.findings.push('fact: the command stopped in an unknown state; its writes are keyed — re-read the drafts by the effects before any retry.');
  if (trail.model_calls.some(call => call.outcome === 'failed' && call.input_tokens === 0))
    trail.findings.push('fact: a model call left without usage figures (transport failure); its cost is unknown, not zero.');
  if (trail.month_hold?.state === 'held')
    trail.findings.push('hypothesis: the month hold is still open; it stops counting after 15 minutes.');
  if (trail.command.reason_code) trail.findings.push(`fact: reason ${trail.command.reason_code}.`);
  return trail;
}

export async function getAssistantSummary(period: ResolvedPeriod): Promise<AssistantSummary> {
  const summary: AssistantSummary = {
    supported: await installed(),
    commands: { total: 0, by_status: [], by_reason: [] },
    model_calls_per_paid_command: null,
    credits: { debited: 0, refunded: 0, by_feature: [] },
    open_holds: 0,
    blind_spots: [...BLIND_SPOTS]
  };
  if (!summary.supported) return summary;
  const range = period.start ? [period.start, period.end] : ['1970-01-01T00:00:00Z', period.end];
  const statuses = await query<Record<string, unknown>>(
    `select status, count(*)::int as count from public.analytics_assistant_commands
      where created_at between $1::timestamptz and $2::timestamptz group by status order by count desc`,
    range
  );
  summary.commands.by_status = statuses.map(row => ({ status: String(row.status), count: n(row.count) }));
  summary.commands.total = summary.commands.by_status.reduce((sum, row) => sum + row.count, 0);
  summary.commands.by_reason = (
    await query<Record<string, unknown>>(
      `select reason_code as reason, count(*)::int as count from public.analytics_assistant_commands
        where reason_code is not null and created_at between $1::timestamptz and $2::timestamptz
        group by reason_code order by count desc`,
      range
    )
  ).map(row => ({ reason: String(row.reason), count: n(row.count) }));
  const calls = await query<Record<string, unknown>>(
    `select count(*)::numeric / nullif(count(distinct c.id), 0) as per
       from public.analytics_assistant_commands c
       join public.analytics_ai_usage_events u on u.subject_id = c.id
      where c.price > 0 and c.created_at between $1::timestamptz and $2::timestamptz`,
    range
  );
  summary.model_calls_per_paid_command = calls[0]?.per === null || calls[0]?.per === undefined ? null : n(calls[0].per);
  const ledger = await query<Record<string, unknown>>(
    `select feature, sum(amount) filter (where kind = 'debit')::int as debited,
            sum(amount) filter (where kind = 'refund')::int as refunded
       from public.analytics_ai_credit_ledger where created_at between $1::timestamptz and $2::timestamptz
      group by feature`,
    range
  );
  summary.credits.by_feature = ledger.map(row => ({ feature: String(row.feature), debited: n(row.debited), refunded: n(row.refunded) }));
  summary.credits.debited = summary.credits.by_feature.reduce((sum, row) => sum + row.debited, 0);
  summary.credits.refunded = summary.credits.by_feature.reduce((sum, row) => sum + row.refunded, 0);
  summary.open_holds = n(
    (await query<{ count: string }>(`select count(*)::text as count from public.analytics_ai_month_holds where state = 'held'`, []))[0]?.count
  );
  return summary;
}
