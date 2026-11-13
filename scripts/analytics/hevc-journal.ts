import { query } from './db.js';
import { getSchema } from './schema.js';
import { isRecord } from '../../packages/shared/src/types.js';
import type { InspectData } from './types.js';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const CODES = [
  'hevc_normalization_started',
  'hevc_normalization_stage',
  'hevc_normalization_completed',
  'hevc_normalization_failed'
];
const STAGES = ['cache_check', 'cache_invalid', 'converting', 'verifying', 'ready'];
const REASONS = [
  'metadata',
  'encode',
  'verify',
  'source_changed',
  'cancelled',
  'timeout',
  'disk_full',
  'cache'
];
const ERRORS = [
  'SOURCE_CHANGED',
  'PROCESS_CANCELED',
  'PROCESS_TIMEOUT',
  'STITCH_TOOL_FAILED',
  'STITCH_VERIFICATION_FAILED'
];
interface Row {
  category?: string;
  code: string;
  props: unknown;
  agent_instance_id: string;
  seq: number | string;
  recorded_at: string;
}
export interface HevcJournalEvidence {
  supported: boolean;
  truncated: boolean;
  consumers: {
    operation_id: string;
    attempt_id: string | null;
    normalization_ids: string[];
    local_outcome: 'ready' | 'failed' | 'cancelled' | 'unknown';
    last_stage: string;
    error_code: string | null;
    reason: string | null;
    from_cache: boolean | null;
  }[];
  records: {
    operation_id: string;
    attempt_id: string | null;
    normalization_id: string | null;
    agent_instance_id: string;
    seq: number;
    at: string;
    stage: string;
  }[];
  blind_spots: string[];
}
/** The bounded forwarded journal proves local preparation only, never catalog delivery. */
export function diagnoseHevcJournal(
  rows: readonly Row[],
  supported: boolean,
  truncated = false
): HevcJournalEvidence {
  const result: HevcJournalEvidence = {
    supported,
    truncated,
    consumers: [],
    records: [],
    blind_spots: [
      'A verified local compatibility copy is not a completed catalog or browser delivery. Read the parent operation and publication receipts separately.',
      'Missing, delayed or retained-away journal records leave interruption and recovery unknown; an incomplete chain is not a failed conversion.'
    ]
  };
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    if (
      (row.category !== undefined && row.category !== 'stitcher') ||
      !CODES.includes(row.code) ||
      !isRecord(row.props) ||
      !UUID.test(String(row.props.operationId)) ||
      !UUID.test(row.agent_instance_id) ||
      !Number.isSafeInteger(Number(row.seq)) ||
      Number(row.seq) < 1 ||
      !Number.isFinite(Date.parse(row.recorded_at))
    )
      continue;
    const operation = String(row.props.operationId);
    const attempt =
      typeof row.props.attemptId === 'string' && UUID.test(row.props.attemptId)
        ? row.props.attemptId
        : null;
    const key = `${operation}:${attempt ?? 'legacy'}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  for (const entries of grouped.values()) {
    const props = entries[0]!.props as Record<string, unknown>;
    const operation = String(props.operationId);
    const attempt =
      typeof props.attemptId === 'string' && UUID.test(props.attemptId) ? props.attemptId : null;
    entries.sort(
      (a, b) =>
        Date.parse(a.recorded_at) - Date.parse(b.recorded_at) || Number(a.seq) - Number(b.seq)
    );
    let stage = 'started';
    const terminals: Row[] = [];
    const ids = new Set<string>();
    for (const row of entries) {
      const p = row.props as Record<string, unknown>;
      const shared =
        typeof p.normalizationId === 'string' && UUID.test(p.normalizationId)
          ? p.normalizationId
          : null;
      if (shared) ids.add(shared);
      stage =
        row.code === CODES[0]
          ? 'started'
          : row.code === CODES[2]
            ? 'ready'
            : row.code === CODES[3]
              ? 'failed'
              : typeof p.stage === 'string' && STAGES.includes(p.stage)
                ? p.stage
                : 'unknown';
      if (row.code === CODES[2] || row.code === CODES[3]) terminals.push(row);
      result.records.push({
        operation_id: operation,
        attempt_id: attempt,
        normalization_id: shared,
        agent_instance_id: row.agent_instance_id,
        seq: Number(row.seq),
        at: new Date(row.recorded_at).toISOString(),
        stage
      });
    }
    const last = terminals.at(-1),
      p = last && isRecord(last.props) ? last.props : {};
    // A resumed/retried consumer may have several terminals. Preserve ambiguity.
    const signatures = new Set(
      terminals.map(
        r => `${r.code}:${JSON.stringify(isRecord(r.props) ? r.props.errorCode : null)}`
      )
    );
    const complete =
      signatures.size === 1 &&
      !truncated &&
      entries.at(-1) === last &&
      entries.filter(row => row.code === CODES[0]).length <= 1;
    result.consumers.push({
      operation_id: operation,
      attempt_id: attempt,
      normalization_ids: [...ids],
      local_outcome: complete
        ? last?.code === CODES[2]
          ? 'ready'
          : p.reason === 'cancelled'
            ? 'cancelled'
            : 'failed'
        : 'unknown',
      last_stage: stage,
      error_code:
        complete && typeof p.errorCode === 'string' && ERRORS.includes(p.errorCode)
          ? p.errorCode
          : null,
      reason:
        complete && typeof p.reason === 'string' && REASONS.includes(p.reason) ? p.reason : null,
      from_cache: complete && typeof p.fromCache === 'boolean' ? p.fromCache : null
    });
    if (signatures.size > 1)
      result.blind_spots.push(
        `Consumer ${operation} has multiple normalization outcomes; inspect each correlated attempt, without inferring a final catalog outcome.`
      );
  }
  result.records.sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) ||
      a.agent_instance_id.localeCompare(b.agent_instance_id) ||
      a.seq - b.seq
  );
  if (!supported) result.blind_spots.push('Native journal source unavailable.');
  if (!result.records.length)
    result.blind_spots.push(
      'No matching HEVC stages were received; this does not prove the source was H.264 or no conversion was attempted.'
    );
  if (truncated)
    result.blind_spots.push('HEVC journal detail is truncated; consumer outcomes remain unknown.');
  return result;
}
export async function getHevcJournalEvidence(
  id: string,
  asOf: string
): Promise<HevcJournalEvidence> {
  const supported = Boolean((await getSchema()).tables.agent_journal_records);
  if (!supported || !UUID.test(id) || !Number.isFinite(Date.parse(asOf)))
    return diagnoseHevcJournal([], supported);
  // Follow the opaque normalization ID to peers, so one cancelled consumer never
  // becomes a claim that the shared conversion or every catalog failed.
  const rows = await query<Row & { user_id: string | null }>(
    `select user_id::text,agent_instance_id::text,seq,recorded_at::text,category,code,props
     from public.agent_journal_records where category='stitcher'
       and code=any($3::text[]) and recorded_at<=$2::timestamptz and received_at<=$2::timestamptz
       and (props->>'operationId'=$1 or props->>'attemptId'=$1 or props->>'normalizationId'=$1 or props->>'normalizationId' in (
         select props->>'normalizationId' from public.agent_journal_records where category='stitcher'
         and code=any($3::text[]) and (props->>'operationId'=$1 or props->>'attemptId'=$1) and recorded_at<=$2::timestamptz and received_at<=$2::timestamptz))
     order by recorded_at,agent_instance_id,seq limit 501`,
    [id, asOf, CODES]
  );
  if (new Set(rows.map(r => r.user_id).filter(Boolean)).size > 1) {
    const ambiguous = diagnoseHevcJournal([], supported);
    ambiguous.blind_spots.push(
      'Ambiguous operation ownership; cross-user native evidence excluded.'
    );
    return ambiguous;
  }
  return diagnoseHevcJournal(rows.slice(0, 500), supported, rows.length > 500);
}
export function mergeHevcInspection(core: InspectData, evidence: HevcJournalEvidence): InspectData {
  if (core.found || !evidence.records.length) return { ...core, hevc_compatibility: evidence };
  const rows = evidence.records;
  return {
    ...core,
    found: true,
    matched_by: ['properties'],
    capability: 'team.hevc_compatibility',
    tool: 'team',
    stages: {
      expected: ['compatible_source_ready', 'catalog_published', 'result_visible'],
      observed: evidence.consumers.some(c => c.local_outcome === 'ready')
        ? ['compatible_source_ready']
        : [],
      missing: [
        'catalog_published',
        'result_visible',
        ...(evidence.consumers.some(c => c.local_outcome === 'ready')
          ? []
          : ['compatible_source_ready'])
      ]
    },
    terminal: null,
    last_proven_stage: `native:${rows.at(-1)!.stage}`,
    first_seen_at: rows[0]!.at,
    last_seen_at: rows.at(-1)!.at,
    events: [],
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    hevc_compatibility: evidence,
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: rows.at(-1)!.agent_instance_id,
      agent_instance_ids: [...new Set(rows.map(r => r.agent_instance_id))],
      agent_platforms: [],
      note: 'Local normalization evidence only; catalog, build and browser delivery are separate observations.'
    }
  };
}
