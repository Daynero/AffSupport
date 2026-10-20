import { query } from './db.js';
import { getSchema } from './schema.js';
export interface WorkspaceEvidence {
  id: string;
  action: 'task_copy' | 'task_cleanup' | 'bulk_trash';
  state: string;
  code: string | null;
  item_count: number;
  confirmed_count: number;
  created_at: string;
  updated_at: string;
}
export interface WorkspaceEvidenceResult {
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
  if (!schema.tables.analytics_workspace_operations)
    return {
      supported: false,
      operations: [],
      blind_spots: [
        'Workspace diagnostic projection is unavailable; missing events do not prove success or absence of work.'
      ]
    };
  if (!actorId)
    return {
      supported: true,
      operations: [],
      blind_spots: ['No authenticated subject for hosted workspace receipts.']
    };
  const rows = await query<Record<string, unknown>>(
    `select id::text,action,state,code,item_count,confirmed_count,created_at::text,updated_at::text from public.analytics_workspace_operations where actor_id=$1::uuid and ($2::timestamptz is null or created_at >= $2::timestamptz) and updated_at <= $3::timestamptz order by created_at desc limit 101`,
    [actorId, since, asOf]
  );
  const operations: WorkspaceEvidence[] = [];
  let malformed = false;
  for (const row of rows.slice(0, 100)) {
    if (
      typeof row.id !== 'string' ||
      !['task_copy', 'task_cleanup', 'bulk_trash'].includes(String(row.action)) ||
      typeof row.state !== 'string' ||
      typeof row.created_at !== 'string' ||
      typeof row.updated_at !== 'string' ||
      (row.code !== null && typeof row.code !== 'string')
    ) {
      malformed = true;
      continue;
    }
    const action = row.action;
    if (action !== 'task_copy' && action !== 'task_cleanup' && action !== 'bulk_trash') continue;
    operations.push({
      id: row.id,
      action,
      state: row.state,
      code: row.code,
      item_count: Number(row.item_count),
      confirmed_count: Number(row.confirmed_count),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }
  return {
    supported: true,
    operations,
    blind_spots: [
      'Hosted receipts prove server state, not browser delivery. Missing correlated result_visible remains unknown.',
      'This is a bounded current-state projection; rows changed after as-of are omitted, not reconstructed as historical success.',
      ...(rows.length > 100 ? ['Workspace evidence truncated at 100 operations.'] : []),
      ...(malformed
        ? ['An unsupported workspace receipt was omitted; its outcome is unknown.']
        : [])
    ]
  };
}
