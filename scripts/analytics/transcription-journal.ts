import { query } from './db.js';
import { getSchema, eventColumnSql } from './schema.js';
import type { InspectFound } from './types.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STAGES = ['accepted', 'input', 'extract', 'transcribe', 'recover', 'save', 'saved'];
export interface OriginalAttemptEvidence {
  attempt_id: string;
  observed: string[];
  outcome: 'success' | 'failure' | 'cancelled' | 'interrupted' | 'unknown';
  omitted_stage_count: number;
  first_seen_at: string;
  last_seen_at: string;
}
export interface OriginalJournalEvidence {
  supported: boolean;
  attempts: OriginalAttemptEvidence[];
  truncated: boolean;
  blind_spots: string[];
}
/** Journal identities and closed stages only. A saved document never proves browser visibility. */
export async function getOriginalJournalEvidence(
  id: string,
  asOf: string,
  bindingId: string | null = null
): Promise<OriginalJournalEvidence> {
  const schema = await getSchema();
  const attemptColumn = eventColumnSql(schema).attemptId;
  const result: OriginalJournalEvidence = {
    supported: Boolean(schema.tables.agent_journal_records),
    attempts: [],
    truncated: false,
    blind_spots: []
  };
  if (!result.supported) {
    result.blind_spots.push('Original transcription journal unavailable.');
    return result;
  }
  if (!UUID.test(id) || !Number.isFinite(Date.parse(asOf))) return result;
  const rows = await query<{ props: Record<string, unknown>; code: string; recorded_at: string }>(
    `select code,props,recorded_at::text from public.agent_journal_records j
 where category='transcription' and received_at <= $2::timestamptz and recorded_at <= $2::timestamptz
 and (props->>'flow_id'=$1 or props->>'run_id'=$1 or props->>'attempt_id'=$1)
 and ($3::text is null or exists (select 1 from public.analytics_events e where e.user_id=j.user_id
   and e.created_at <= $2::timestamptz and e.properties->>'flow_step' in ('library_original_processing','transcription_original','transcription_result_visible')
   and (${attemptColumn}=$3 or e.run_id::text=$3 or e.flow_id::text=$3)))
 order by received_at desc,id desc limit 501`,
    [id, asOf, bindingId]
  );
  result.truncated = rows.length > 500;
  if (result.truncated)
    result.blind_spots.push('Original journal detail truncated; missing stages remain unknown.');
  const attempts = new Map<string, OriginalAttemptEvidence>();
  for (const row of rows.slice(0, 500).reverse()) {
    const p = row.props,
      at = Date.parse(row.recorded_at);
    if (
      !p ||
      p.api_version !== 6 ||
      typeof p.attempt_id !== 'string' ||
      !UUID.test(p.attempt_id) ||
      !Number.isFinite(at) ||
      !['accepted', 'stage', 'terminal', 'stages_omitted'].includes(row.code)
    )
      continue;
    let attempt = attempts.get(p.attempt_id);
    if (!attempt) {
      attempt = {
        attempt_id: p.attempt_id,
        observed: [],
        outcome: 'unknown',
        omitted_stage_count: 0,
        first_seen_at: new Date(at).toISOString(),
        last_seen_at: new Date(at).toISOString()
      };
      attempts.set(p.attempt_id, attempt);
    }
    attempt.last_seen_at = new Date(at).toISOString();
    const stage =
      row.code === 'accepted'
        ? 'accepted'
        : row.code === 'stage' && typeof p.stage === 'string' && STAGES.includes(p.stage)
          ? p.stage
          : null;
    if (stage && !attempt.observed.includes(stage)) attempt.observed.push(stage);
    if (row.code === 'terminal') {
      if (['success', 'failure', 'cancelled', 'interrupted'].includes(String(p.outcome)))
        attempt.outcome = p.outcome as OriginalAttemptEvidence['outcome'];
      if (
        typeof p.omitted_stage_count === 'number' &&
        Number.isSafeInteger(p.omitted_stage_count) &&
        p.omitted_stage_count >= 0
      )
        attempt.omitted_stage_count = p.omitted_stage_count;
    }
  }
  result.attempts = [...attempts.values()];
  if (result.attempts.some(attempt => attempt.outcome === 'unknown'))
    result.blind_spots.push('Missing native terminal; interruption and delivery remain unknown.');
  return result;
}
export function inspectOriginalJournal(
  id: string,
  evidence: OriginalJournalEvidence
): InspectFound | null {
  const latest = evidence.attempts.at(-1);
  if (!latest) return null;
  const expected = ['accepted', 'extract', 'transcribe', 'saved', 'result_visible'];
  return {
    found: true,
    id,
    matched_by: ['attempt_id'],
    capability: 'transcription.run',
    tool: 'transcription',
    stages: {
      expected,
      observed: latest.observed,
      missing: expected.filter(stage => !latest.observed.includes(stage))
    },
    terminal: null,
    last_proven_stage: latest.observed.at(-1) ?? null,
    first_seen_at: latest.first_seen_at,
    last_seen_at: latest.last_seen_at,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    events: [],
    transcription_original: evidence,
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: [],
      note: 'API6 native journal evidence. Native terminal is separate from result visibility; browser delivery remains unknown.'
    }
  };
}
