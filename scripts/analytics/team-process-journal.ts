import {
  isRecord,
  TEAM_ERROR_CODES,
  STITCH_ERROR_CODES,
  COMPRESSION_ERROR_CODES
} from '../../packages/shared/src/types.js';
import { query } from './db.js';
import { getSchema } from './schema.js';
import type { TeamSourceIntegrityReason } from '../../apps/agent/src/team-bridge/transfer.js';
import type { InspectData, InspectFound } from './types.js';

export interface TeamProcessJournalEvidence {
  supported: boolean;
  truncated: boolean;
  records: Array<{
    agent_instance_id: string;
    seq: number;
    at: string;
    stage: string;
    outcome: 'failure' | 'cancelled';
    error_code: string | null;
    source_integrity_reason?: TeamSourceIntegrityReason | null;
  }>;
  blind_spots: string[];
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const CODES = new Set<string>([
  ...TEAM_ERROR_CODES,
  ...STITCH_ERROR_CODES,
  ...COMPRESSION_ERROR_CODES
]);
const STAGES = new Set([
  'downloading',
  'preparing',
  'processing',
  'uploading',
  'finalizing',
  'failed',
  'canceled',
  'unknown'
]);
/** Exact operation correlation only; nearby unbound failures never become this run's cause. */
export async function getTeamProcessJournalEvidence(
  id: string,
  asOf: string
): Promise<TeamProcessJournalEvidence> {
  const schema = await getSchema();
  const result: TeamProcessJournalEvidence = {
    supported: Boolean(schema.tables.agent_journal_records),
    truncated: false,
    records: [],
    blind_spots: []
  };
  if (!result.supported) {
    result.blind_spots.push('Native team journal unavailable.');
    return result;
  }
  if (!UUID.test(id) || !Number.isFinite(Date.parse(asOf))) return result;
  const rows = await query<{
    user_id: string | null;
    agent_instance_id: string;
    seq: number | string;
    recorded_at: string;
    props: unknown;
  }>(
    `select user_id::text,agent_instance_id::text,seq,recorded_at::text,props
     from public.agent_journal_records where category='team' and code='process_terminal'
       and props->>'operationId'=$1 and recorded_at <= $2::timestamptz and received_at <= $2::timestamptz
     order by recorded_at, agent_instance_id, seq limit 501`,
    [id, asOf]
  ).catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const reason =
      code === '57014' || code === 'ANALYTICS_QUERY_TIMEOUT'
        ? 'timeout'
        : code === '42501'
          ? 'permission'
          : ['42P01', '42703'].includes(code)
            ? 'schema'
            : null;
    if (!reason) throw error;
    result.blind_spots.push(
      `Native team journal source unavailable (${reason}); terminal and cause remain unknown.`
    );
    return [];
  });
  result.truncated = rows.length > 500;
  if (new Set(rows.map(row => row.user_id).filter(Boolean)).size > 1) {
    result.blind_spots.push('Ambiguous native operation ownership; no terminal inferred.');
    return result;
  }
  for (const row of rows.slice(0, 500)) {
    const p = row.props;
    if (!isRecord(p) || !Number.isSafeInteger(Number(row.seq)) || Number(row.seq) < 1) continue;
    if (
      !UUID.test(row.agent_instance_id) ||
      !Number.isFinite(Date.parse(row.recorded_at)) ||
      (p.outcome !== 'failed' && p.outcome !== 'canceled')
    )
      continue;
    result.records.push({
      agent_instance_id: row.agent_instance_id,
      seq: Number(row.seq),
      at: new Date(row.recorded_at).toISOString(),
      stage: typeof p.stage === 'string' && STAGES.has(p.stage) ? p.stage : 'unknown',
      outcome: p.outcome === 'canceled' ? 'cancelled' : 'failure',
      error_code: typeof p.errorCode === 'string' && CODES.has(p.errorCode) ? p.errorCode : null,
      source_integrity_reason:
        p.outcome === 'failed' &&
        p.stage === 'downloading' &&
        ((p.sourceIntegrityReason === 'checksum_invalid' && p.errorCode === 'INVALID_RESPONSE') ||
          ((p.sourceIntegrityReason === 'checksum_mismatch' ||
            p.sourceIntegrityReason === 'size_mismatch') &&
            p.errorCode === 'SOURCE_CHANGED'))
          ? p.sourceIntegrityReason
          : null
    });
  }
  if (
    result.records.some(
      row =>
        row.stage === 'downloading' &&
        row.error_code === 'SOURCE_CHANGED' &&
        !row.source_integrity_reason
    )
  )
    result.blind_spots.push(
      'Native source changed during download; byte-integrity detail was not observed.'
    );
  if (result.truncated)
    result.blind_spots.push(
      'Native terminal detail truncated; conflicting or missing evidence remains unknown.'
    );
  return result;
}
export function mergeTeamProcessJournal(
  core: InspectData,
  evidence: TeamProcessJournalEvidence
): InspectData {
  if (!evidence.records.length)
    return evidence.blind_spots.length ? { ...core, team_native: evidence } : core;
  evidence = { ...evidence, blind_spots: [...evidence.blind_spots] };
  const signatures = new Set(evidence.records.map(row => `${row.outcome}:${row.error_code}`));
  const integrityReasons = new Set(
    evidence.records.flatMap(row =>
      row.source_integrity_reason ? [row.source_integrity_reason] : []
    )
  );
  if (integrityReasons.size > 1)
    evidence.blind_spots.push(
      'Conflicting native source integrity details; no single integrity cause inferred.'
    );
  const latest = evidence.records.at(-1)!;
  if (signatures.size !== 1 || evidence.truncated)
    evidence.blind_spots.push(
      'Conflicting or incomplete native terminals; no single native outcome inferred.'
    );
  const nativeTerminal =
    signatures.size === 1 && !evidence.truncated
      ? {
          event: 'journal:team:process_terminal',
          outcome: latest.outcome,
          occurred_at: latest.at
        }
      : null;
  const conflictingSources = Boolean(
    core.found &&
    core.terminal &&
    nativeTerminal &&
    core.terminal.outcome !== nativeTerminal.outcome
  );
  if (conflictingSources)
    evidence.blind_spots.push(
      'Conflicting browser/server and native terminals; final outcome requires reconciliation.'
    );
  if (evidence.records.some(row => row.outcome === 'failure' && row.error_code === null))
    evidence.blind_spots.push(
      'Native failure code missing or unrecognized; cause remains unknown.'
    );
  const deliveryKnown = core.found && core.stages.observed.includes('result_visible');
  if (!deliveryKnown)
    evidence.blind_spots.push('Native execution terminal does not prove browser delivery.');
  if (core.found)
    return {
      ...core,
      team_native: evidence,
      terminal: conflictingSources ? null : (core.terminal ?? nativeTerminal),
      last_proven_stage: core.terminal
        ? core.last_proven_stage
        : nativeTerminal
          ? `native:${latest.stage}`
          : core.last_proven_stage
    };
  const instances = [...new Set(evidence.records.map(row => row.agent_instance_id))];
  const found: InspectFound = {
    found: true,
    id: core.id,
    capability: 'team.process',
    tool: 'team',
    matched_by: ['properties'],
    stages: {
      expected: ['native_terminal', 'result_visible'],
      observed: nativeTerminal ? ['native_terminal'] : [],
      missing: nativeTerminal ? ['result_visible'] : ['native_terminal', 'result_visible']
    },
    terminal: nativeTerminal,
    last_proven_stage: `native:${latest.stage}`,
    first_seen_at: evidence.records[0]!.at,
    last_seen_at: latest.at,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    events: [],
    team_native: evidence,
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: latest.agent_instance_id,
      agent_instance_ids: instances,
      agent_platforms: [],
      note: 'Native journal proves the execution terminal only; build, platform and browser delivery remain unknown.'
    }
  };
  return found;
}
