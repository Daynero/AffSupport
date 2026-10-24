import { query } from './db.js';
import { eventColumnSql, getSchema } from './schema.js';
import {
  RECOVERY_RETIREMENT_ACK_REASONS,
  type RecoveryRetirementAckReason
} from '../../packages/shared/src/types.js';

export interface RecoveryRetirementReceipt {
  actor_id: string;
  attempt_id: string;
  installation_id: string;
  retired_count: number;
  confirmed_at: string;
  server_outcome: 'confirmed';
  browser_outcome: 'confirmed' | 'unconfirmed' | 'unknown';
  browser_reason?: RecoveryRetirementAckReason;
  browser_evidence?: string[];
  native_cleanup: 'unknown';
}
export interface RecoveryRetirementEvidence {
  supported: boolean;
  receipts: RecoveryRetirementReceipt[];
  blind_spots: string[];
}
export type RetirementSubjectKind = 'actor' | 'attempt' | 'installation' | 'any';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A committed server receipt proves revocation, never browser receipt or protected-key cleanup. */
export async function getRecoveryRetirementEvidence(
  id: string,
  since: string | null,
  asOf: string,
  kind: RetirementSubjectKind = 'any'
): Promise<RecoveryRetirementEvidence> {
  const schema = await getSchema();
  if (!schema.tables.analytics_recovery_retirement) {
    return {
      supported: false,
      receipts: [],
      blind_spots: [
        'Retirement receipt projection is unavailable; missing evidence never proves revocation.'
      ]
    };
  }
  const end = Date.parse(asOf),
    start = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
  if (
    !UUID.test(id) ||
    !['actor', 'attempt', 'installation', 'any'].includes(kind) ||
    !Number.isFinite(end) ||
    Number.isNaN(start) ||
    start > end
  ) {
    return {
      supported: true,
      receipts: [],
      blind_spots: ['Retirement subject or time window is invalid; no unscoped query was issued.']
    };
  }
  const eventColumns = eventColumnSql(schema);
  const rows = await query<Record<string, unknown>>(
    `select r.actor_id::text,r.attempt_id::text,r.installation_id::text,r.retired_count,r.confirmed_at::text,
       coalesce(browser.terminals,'[]'::jsonb) as browser_terminals
     from public.analytics_recovery_retirement r
     left join lateral (
       select jsonb_agg(b.terminal order by b.created_at desc,b.id desc) as terminals
       from (
         select e.id,e.created_at,jsonb_build_object(
           'evidence','event:' || coalesce(e.event_id::text,e.id::text),
           'name',e.event_name,'outcome',coalesce(e.outcome,e.properties->>'outcome'),
           'code',coalesce(e.error_code,e.properties->>'error_code'),
           'reason',e.properties->>'error_category') as terminal
         from public.analytics_events e
         where e.user_id=r.actor_id and lower(${eventColumns.attemptId})=r.attempt_id::text
           and e.properties->>'flow_step'='recovery_retirement_ack'
           and e.event_name in ('operation_completed','operation_failed')
           and e.created_at >= r.confirmed_at and e.created_at <= $3::timestamptz
         order by e.created_at desc,e.id desc limit 101
       ) b
     ) browser on true
     where (($4::text='actor' and r.actor_id=$1::uuid)
       or ($4::text='attempt' and r.attempt_id=$1::uuid)
       or ($4::text='installation' and r.installation_id=$1::uuid)
       or ($4::text='any' and (r.actor_id=$1::uuid or r.attempt_id=$1::uuid or r.installation_id=$1::uuid)))
      and ($2::timestamptz is null or r.confirmed_at >= $2::timestamptz)
      and r.confirmed_at <= $3::timestamptz
     order by r.confirmed_at desc,r.actor_id,r.attempt_id limit 101`,
    [id, since, asOf, kind]
  );
  const receipts: RecoveryRetirementReceipt[] = [],
    blind_spots: string[] = [];
  for (const row of rows.slice(0, 100)) {
    const keys = [row.actor_id, row.attempt_id, row.installation_id];
    const scopeKeys =
      kind === 'actor'
        ? [row.actor_id]
        : kind === 'attempt'
          ? [row.attempt_id]
          : kind === 'installation'
            ? [row.installation_id]
            : keys;
    const at = typeof row.confirmed_at === 'string' ? Date.parse(row.confirmed_at) : Number.NaN;
    if (
      !keys.every(value => typeof value === 'string' && UUID.test(value)) ||
      !scopeKeys.some(
        value => typeof value === 'string' && value.toLowerCase() === id.toLowerCase()
      ) ||
      typeof row.retired_count !== 'number' ||
      !Number.isSafeInteger(row.retired_count) ||
      row.retired_count < 0 ||
      !Number.isFinite(at) ||
      at < start ||
      at > end
    )
      continue;
    const terminals: unknown[] = Array.isArray(row.browser_terminals) ? row.browser_terminals : [];
    let browserOutcome: RecoveryRetirementReceipt['browser_outcome'] = 'unknown';
    const outcomes = new Set<'confirmed' | 'unconfirmed'>();
    const reasons = new Set<RecoveryRetirementAckReason>();
    const evidence: string[] = [];
    let invalidTerminal = false;
    for (const terminal of terminals.slice(0, 100)) {
      if (!terminal || typeof terminal !== 'object') {
        invalidTerminal = true;
        continue;
      }
      const value = terminal as Record<string, unknown>;
      if (
        typeof value.evidence !== 'string' ||
        !/^event:(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(
          value.evidence
        )
      ) {
        invalidTerminal = true;
        continue;
      }
      if (value.name === 'operation_completed' && value.outcome === 'success')
        outcomes.add('confirmed');
      else if (
        value.name === 'operation_failed' &&
        value.outcome === 'failure' &&
        value.code === 'RECOVERY_RETIREMENT_UNCONFIRMED'
      ) {
        outcomes.add('unconfirmed');
        reasons.add(
          RECOVERY_RETIREMENT_ACK_REASONS.includes(value.reason as RecoveryRetirementAckReason)
            ? (value.reason as RecoveryRetirementAckReason)
            : 'unknown'
        );
      } else {
        invalidTerminal = true;
        continue;
      }
      evidence.push(value.evidence);
    }
    if (terminals.length > 100)
      blind_spots.push(
        'Browser retirement terminal detail truncated at100; acknowledgement remains unknown.'
      );
    else if (invalidTerminal)
      blind_spots.push(
        'Malformed browser retirement terminal evidence; acknowledgement remains unknown.'
      );
    else if (outcomes.size > 1)
      blind_spots.push(
        'Browser retirement terminals have conflicting outcomes; acknowledgement remains unknown.'
      );
    else if (outcomes.size === 1) browserOutcome = [...outcomes][0]!;
    receipts.push({
      actor_id: (row.actor_id as string).toLowerCase(),
      attempt_id: (row.attempt_id as string).toLowerCase(),
      installation_id: (row.installation_id as string).toLowerCase(),
      retired_count: row.retired_count,
      confirmed_at: new Date(at).toISOString(),
      server_outcome: 'confirmed',
      browser_outcome: browserOutcome,
      ...(browserOutcome !== 'unknown' ? { browser_evidence: [...new Set(evidence)] } : {}),
      ...(browserOutcome === 'unconfirmed'
        ? { browser_reason: reasons.size === 1 ? [...reasons][0]! : ('unknown' as const) }
        : {}),
      native_cleanup: 'unknown'
    });
  }
  if (receipts.length !== Math.min(rows.length, 100))
    blind_spots.push(
      'Some retirement receipt rows could not be validated; their outcomes remain unknown.'
    );
  if (rows.length > 100)
    blind_spots.push(
      'Retirement receipts truncated at 100 records; omitted outcomes remain unknown.'
    );
  return { supported: true, receipts, blind_spots };
}

/** An authoritative server result is deliberately not a user-visible terminal. */
export function inspectRecoveryRetirement(
  id: string,
  result: RecoveryRetirementEvidence
): import('./types.js').InspectFound | null {
  if (!result.receipts.length) return null;
  const acknowledged = result.receipts.some(receipt => receipt.browser_outcome === 'confirmed');
  return {
    found: true,
    id,
    matched_by: ['authoritative_table'],
    capability: 'team.recovery_retirement',
    tool: 'team',
    stages: {
      expected: ['server_confirmed', 'browser_confirmed', 'local_complete'],
      observed: acknowledged ? ['server_confirmed', 'browser_confirmed'] : ['server_confirmed'],
      missing: acknowledged ? ['local_complete'] : ['browser_confirmed', 'local_complete']
    },
    terminal: null,
    last_proven_stage: acknowledged ? 'browser_confirmed' : 'server_confirmed',
    first_seen_at: result.receipts.at(-1)!.confirmed_at,
    last_seen_at: result.receipts[0]!.confirmed_at,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    events: [],
    recovery_retirement: result,
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: [],
      note: acknowledged
        ? 'The server confirmed actor-scoped retirement and a matching browser acknowledgement was observed; native protected-key cleanup remains unknown.'
        : 'The server confirmed actor-scoped retirement; no matching browser confirmation was established and native protected-key cleanup remains unknown.'
    }
  };
}
