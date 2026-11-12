import {
  NATIVE_UPDATE_CODES,
  NATIVE_UPDATE_STAGES,
  isUpdateUuid
} from '../../packages/shared/src/native-app-updates.js';
import { query } from './db.js';
import { getSchema } from './schema.js';
import type { ResolvedPeriod, InspectFound } from './types.js';
export interface NativeUpdateAttemptEvidence {
  installation_id: string;
  operation_id: string | null;
  attempt_id: string;
  target: string | null;
  artifact_sha256: string | null;
  observed_stages: string[];
  last_proven_stage: string | null;
  error_code: string | null;
  native_success: boolean;
  ui_success: boolean;
  outcome: string;
  first_seen_at: string;
  last_seen_at: string;
}
export interface NativeUpdateEvidence {
  supported: boolean;
  attempts: NativeUpdateAttemptEvidence[];
  truncated: boolean;
  invalid_records: number;
  blind_spots: string[];
}
export interface NativeUpdateJournalRow {
  props: Record<string, unknown>;
  recorded_at: string;
}
/** Receipts prove stages; a lost journal or new version string never proves success. */
export function diagnoseNativeUpdates(
  rows: NativeUpdateJournalRow[],
  supported = true
): NativeUpdateEvidence {
  const result: NativeUpdateEvidence = {
    supported,
    attempts: [],
    truncated: rows.length > 1000,
    invalid_records: 0,
    blind_spots: []
  };
  if (!supported) result.blind_spots.push('Native update journal is unavailable.');
  if (result.truncated)
    result.blind_spots.push('Native update detail truncated; missing stages remain unknown.');
  const attempts = new Map<string, NativeUpdateAttemptEvidence>();
  const revisions = new Map<string, number>();
  // Cross-boot receipt replay can arrive late. The native revision is the order
  // within one installation; recorded_at remains delivery/observation evidence.
  const ordered = rows
    .slice(0, 1000)
    .sort((a, b) => Number(a.props.revision) - Number(b.props.revision));
  for (const row of ordered) {
    const p = row.props;
    if (!isUpdateUuid(p.attempt_id)) continue; // Offers have no accepted attempt yet.
    if (
      !isUpdateUuid(p.installation_id) ||
      !Number.isSafeInteger(p.revision) ||
      !NATIVE_UPDATE_STAGES.some(stage => stage === p.stage) ||
      (p.error_code !== undefined && !NATIVE_UPDATE_CODES.some(code => code === p.error_code)) ||
      typeof p.native_success !== 'boolean' ||
      typeof p.ui_success !== 'boolean' ||
      (p.ui_success && !p.native_success) ||
      !Number.isFinite(Date.parse(row.recorded_at))
    ) {
      result.invalid_records++;
      continue;
    }
    const key = `${p.installation_id}:${p.attempt_id}`;
    if ((revisions.get(key) ?? -1) >= Number(p.revision)) continue;
    revisions.set(key, Number(p.revision));
    let attempt = attempts.get(key);
    if (!attempt) {
      attempt = {
        installation_id: p.installation_id,
        attempt_id: p.attempt_id,
        operation_id: isUpdateUuid(p.operation_id) ? p.operation_id : null,
        target: ['macos-arm64', 'macos-x64'].includes(String(p.target)) ? String(p.target) : null,
        artifact_sha256:
          typeof p.artifact_sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.artifact_sha256)
            ? p.artifact_sha256
            : null,
        observed_stages: [],
        last_proven_stage: null,
        error_code: null,
        native_success: false,
        ui_success: false,
        outcome: 'unknown',
        first_seen_at: row.recorded_at,
        last_seen_at: row.recorded_at
      };
      attempts.set(key, attempt);
    }
    const stage = String(p.stage);
    if (!attempt.observed_stages.includes(stage)) attempt.observed_stages.push(stage);
    if (NATIVE_UPDATE_STAGES.some(known => known === p.last_proven_stage))
      attempt.last_proven_stage = String(p.last_proven_stage);
    else if (!['failed', 'recovering', 'unknown'].includes(stage))
      attempt.last_proven_stage = stage;
    attempt.error_code = typeof p.error_code === 'string' ? p.error_code : null;
    attempt.native_success ||= p.native_success && ['native_ready', 'ui_visible'].includes(stage);
    attempt.ui_success ||= p.ui_success && stage === 'ui_visible' && attempt.native_success;
    attempt.outcome = attempt.ui_success
      ? 'ui_success'
      : attempt.native_success
        ? 'native_success_ui_unconfirmed'
        : ['failed', 'cancelled', 'deferred'].includes(stage)
          ? stage
          : ['unknown', 'recovering'].includes(stage)
            ? 'unknown'
            : 'in_progress';
    attempt.first_seen_at = [attempt.first_seen_at, row.recorded_at].sort()[0]!;
    attempt.last_seen_at = [attempt.last_seen_at, row.recorded_at].sort().at(-1)!;
  }
  result.attempts = [...attempts.values()];
  if (result.invalid_records)
    result.blind_spots.push(
      'Invalid native update receipts were ignored; their causes remain unknown.'
    );
  if (!rows.length && supported)
    result.blind_spots.push(
      'No delivered native receipts in this window; this does not prove no updates occurred.'
    );
  if (result.attempts.some(a => !a.ui_success))
    result.blind_spots.push(
      'Browser visibility is unconfirmed until an explicit UI acknowledgement reaches the native host and is delivered back.'
    );
  result.blind_spots.push(
    'Offline native work is visible only after a browser forwards the bounded journal; absence or retention loss is not success.'
  );
  return result;
}
export async function getNativeUpdateEvidence(
  period: ResolvedPeriod,
  identity: { userId?: string | null; id?: string | null } = {}
): Promise<NativeUpdateEvidence> {
  const schema = await getSchema();
  if (!schema.tables.agent_journal_records) return diagnoseNativeUpdates([], false);
  if (
    (identity.id && !isUpdateUuid(identity.id)) ||
    (identity.userId && !isUpdateUuid(identity.userId))
  )
    return diagnoseNativeUpdates([]);
  const rows = await query<NativeUpdateJournalRow>(
    `select props,recorded_at::text from public.agent_journal_records
    where category=$5::text and code=$6::text
      and ($1::timestamptz is null or recorded_at >= $1::timestamptz)
      and recorded_at <= $2::timestamptz and received_at <= $2::timestamptz
      and ($3::uuid is null or user_id=$3::uuid)
      and ($4::text is null or props->>'attempt_id'=$4 or props->>'operation_id'=$4 or props->>'installation_id'=$4)
    order by received_at desc,id desc limit 1001`,
    [
      period.start,
      period.end,
      identity.userId ?? null,
      identity.id ?? null,
      'update',
      'native_update_stage'
    ]
  );
  return diagnoseNativeUpdates(rows);
}
export function inspectNativeUpdate(
  id: string,
  evidence: NativeUpdateEvidence
): InspectFound | null {
  const a = evidence.attempts.find(a =>
    [a.attempt_id, a.operation_id, a.installation_id].includes(id)
  );
  if (!a) return null;
  return {
    found: true,
    id,
    matched_by: ['properties'],
    capability: 'update.native_app',
    tool: 'update',
    native_app_update: evidence,
    stages: {
      expected: [...NATIVE_UPDATE_STAGES],
      observed: a.observed_stages,
      missing: NATIVE_UPDATE_STAGES.filter(s => !a.observed_stages.includes(s))
    },
    terminal: [
      'ui_success',
      'native_success_ui_unconfirmed',
      'cancelled',
      'deferred',
      'failed'
    ].includes(a.outcome)
      ? {
          event: 'journal:update:native_update_stage',
          outcome: a.outcome,
          occurred_at: a.last_seen_at
        }
      : null,
    last_proven_stage: a.last_proven_stage,
    first_seen_at: a.first_seen_at,
    last_seen_at: a.last_seen_at,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: ['macos'],
      note: 'Native receipt identity proves the target; physical hardware remains unknown.'
    },
    events: []
  };
}
