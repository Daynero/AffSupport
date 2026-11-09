import {
  getRestitchSelectionEvidence,
  type RestitchSelectionEvidence
} from './restitch-selections.js';
import { getMaterialGroupEvidence, type MaterialGroupEvidence } from './material-groups.js';
import { query } from './db.js';
import { getSchema } from './schema.js';
import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';

const KNOWN_TEAM_CODES = new Set<string>(TEAM_ERROR_CODES);
const RESTORE_STATES = new Set(['pending', 'running', 'confirmed', 'failed', 'cancelled']);
const PROCESS_STATES = new Set([
  'prepared',
  'started',
  'confirmed',
  'pending',
  'claimed',
  'waiting',
  'trashed',
  'cancelled',
  'attention'
]);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9TtZz +:.-]{1,64}$/u.test(value) &&
  Number.isFinite(Date.parse(value));

export interface ProcessOutputCleanupEvidence {
  upload_state: 'prepared' | 'started' | 'published';
  state: 'not_needed' | 'pending' | 'claimed' | 'waiting' | 'trashed' | 'not_created' | 'attention';
  attempts: number;
  max_attempts: number;
  captured_handoff_expires_at: string;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
  provider_mutation_reserved: boolean;
  provider_material_registered: boolean;
  provider_result_recorded: boolean;
}
export interface WorkspaceEvidence {
  id: string;
  action: 'task_copy' | 'task_cleanup' | 'bulk_trash' | 'process_output_cleanup' | 'restore';
  state: string;
  code: string | null;
  item_count: number;
  confirmed_count: number;
  created_at: string;
  updated_at: string;
  cleanup?: ProcessOutputCleanupEvidence;
}
export interface WorkspaceEvidenceResult {
  restitch_selections?: RestitchSelectionEvidence;
  material_groups?: MaterialGroupEvidence;
  supported: boolean;
  operations: WorkspaceEvidence[];
  blind_spots: string[];
}
/** A closed, bound SELECT against a privacy-limited projection; never reads content or provider identifiers. */
export async function getWorkspaceEvidence(
  actorId: string | null,
  since: string | null,
  asOf: string
): Promise<WorkspaceEvidenceResult> {
  const schema = await getSchema();
  const [materialGroups, restitchSelections] = await Promise.all([
    getMaterialGroupEvidence({ actorId, since, asOf }),
    getRestitchSelectionEvidence({ actorId, since, asOf })
  ]);
  if (!schema.tables.analytics_workspace_operations)
    return {
      supported: false,
      operations: [],
      material_groups: materialGroups,
      restitch_selections: restitchSelections,
      blind_spots: [
        ...materialGroups.blind_spots,
        ...restitchSelections.blind_spots,
        'Workspace diagnostic projection is unavailable; missing events do not prove success or absence of work.'
      ]
    };
  if (!actorId)
    return {
      supported: true,
      operations: [],
      material_groups: materialGroups,
      restitch_selections: restitchSelections,
      blind_spots: ['No authenticated subject for hosted workspace receipts.']
    };
  let rows: Record<string, unknown>[];
  try {
    rows = await query<Record<string, unknown>>(
      `select id::text,action,state,code,item_count,confirmed_count,created_at::text,updated_at::text from public.analytics_workspace_operations where actor_id=$1::uuid and ($2::timestamptz is null or created_at >= $2::timestamptz) and updated_at <= $3::timestamptz order by created_at desc limit 101`,
      [actorId, since, asOf]
    );
  } catch {
    return {
      supported: true,
      operations: [],
      material_groups: materialGroups,
      restitch_selections: restitchSelections,
      blind_spots: [
        ...materialGroups.blind_spots,
        ...restitchSelections.blind_spots,
        'Workspace diagnostic read failed; missing receipts do not prove success or absence of work.'
      ]
    };
  }
  const operations: WorkspaceEvidence[] = [];
  let malformed = false;
  let unknownRestoreCode = false;
  for (const row of rows.slice(0, 100)) {
    if (
      typeof row.id !== 'string' ||
      !['task_copy', 'task_cleanup', 'bulk_trash', 'process_output_cleanup', 'restore'].includes(
        String(row.action)
      ) ||
      typeof row.state !== 'string' ||
      typeof row.created_at !== 'string' ||
      typeof row.updated_at !== 'string' ||
      (row.code !== null && typeof row.code !== 'string') ||
      (row.action === 'process_output_cleanup' &&
        (!PROCESS_STATES.has(String(row.state)) ||
          (row.code !== null && !KNOWN_TEAM_CODES.has(String(row.code))))) ||
      (row.action === 'restore' &&
        (!RESTORE_STATES.has(String(row.state)) ||
          !timestamp(row.created_at) ||
          !timestamp(row.updated_at)))
    ) {
      malformed = true;
      continue;
    }
    const action = row.action;
    if (
      action !== 'task_copy' &&
      action !== 'task_cleanup' &&
      action !== 'bulk_trash' &&
      action !== 'process_output_cleanup' &&
      action !== 'restore'
    )
      continue;
    const code =
      action === 'restore' && row.code !== null && !KNOWN_TEAM_CODES.has(String(row.code))
        ? 'UNKNOWN'
        : row.code;
    if (action === 'restore' && code === 'UNKNOWN') unknownRestoreCode = true;
    operations.push({
      id: row.id,
      action,
      state: row.state,
      code: code as string | null,
      item_count: Number(row.item_count),
      confirmed_count: Number(row.confirmed_count),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }
  let cleanupIncomplete = false;
  if (schema.tables.analytics_process_output_cleanup) {
    let details: Record<string, unknown>[] = [];
    try {
      details = await query<Record<string, unknown>>(
        `select id::text,upload_state,cleanup_state,attempts,max_attempts,captured_handoff_expires_at::text,next_attempt_at::text,lease_expires_at::text,provider_mutation_reserved,provider_material_registered,provider_result_recorded,updated_at::text from public.analytics_process_output_cleanup where actor_id=$1::uuid and ($2::timestamptz is null or created_at >= $2::timestamptz) and updated_at <= $3::timestamptz order by created_at desc limit 101`,
        [actorId, since, asOf]
      );
    } catch {
      cleanupIncomplete = true;
    }
    for (const operation of operations.filter(item => item.action === 'process_output_cleanup')) {
      const detail = details.find(
        row => row.id === operation.id && row.updated_at === operation.updated_at
      );
      if (
        !detail ||
        !['prepared', 'started', 'published'].includes(String(detail.upload_state)) ||
        ![
          'not_needed',
          'pending',
          'claimed',
          'waiting',
          'trashed',
          'not_created',
          'attention'
        ].includes(String(detail.cleanup_state)) ||
        !Number.isInteger(detail.attempts) ||
        Number(detail.attempts) < 0 ||
        Number(detail.attempts) > 24 ||
        detail.max_attempts !== 24 ||
        typeof detail.provider_mutation_reserved !== 'boolean' ||
        typeof detail.provider_material_registered !== 'boolean' ||
        typeof detail.provider_result_recorded !== 'boolean' ||
        !timestamp(detail.captured_handoff_expires_at) ||
        (detail.next_attempt_at !== null && !timestamp(detail.next_attempt_at)) ||
        (detail.lease_expires_at !== null && !timestamp(detail.lease_expires_at))
      ) {
        cleanupIncomplete = true;
        continue;
      }
      operation.cleanup = {
        upload_state: detail.upload_state as ProcessOutputCleanupEvidence['upload_state'],
        state: detail.cleanup_state as ProcessOutputCleanupEvidence['state'],
        attempts: Number(detail.attempts),
        max_attempts: 24,
        captured_handoff_expires_at: detail.captured_handoff_expires_at,
        next_attempt_at: detail.next_attempt_at as string | null,
        lease_expires_at: detail.lease_expires_at as string | null,
        provider_mutation_reserved: detail.provider_mutation_reserved,
        provider_material_registered: detail.provider_material_registered,
        provider_result_recorded: detail.provider_result_recorded
      };
    }
  }
  return {
    supported: true,
    operations,
    material_groups: materialGroups,
    restitch_selections: restitchSelections,
    blind_spots: [
      ...materialGroups.blind_spots,
      ...restitchSelections.blind_spots,
      ...(unknownRestoreCode
        ? ['A restore receipt has an unrecognized cause; its underlying failure remains unknown.']
        : []),
      ...(!schema.tables.analytics_process_output_cleanup
        ? [
            'Process upload ownership projection is unavailable; missing cleanup receipts do not prove absence of a late provider output.'
          ]
        : []),
      'Hosted receipts prove server state, not browser delivery. Missing correlated result_visible remains unknown.',
      'This is a bounded current-state projection; rows changed after as-of are omitted, not reconstructed as historical success.',
      'Reference booleans describe current observed registration and recorded-result state, not their history at as-of; a reference change can leave an older ownership receipt timestamp.',
      ...(rows.length > 100 ? ['Workspace evidence truncated at 100 operations.'] : []),
      ...(malformed
        ? ['An unsupported workspace receipt was omitted; its outcome is unknown.']
        : []),
      ...(cleanupIncomplete
        ? [
            'Process cleanup detail was unavailable, changed during readback or malformed; its exact stage and retry budget remain unknown. The provider mutation reservation is unknown too.'
          ]
        : [])
    ]
  };
}
