import { query } from './db.js';
import { getSchema } from './schema.js';
export interface MembershipAccessEvidence {
  supported: boolean;
  signals: { team_id: string; revision: string; changed_at: string; browser_delivery: 'unknown' }[];
  blind_spots: string[];
}
/** Bound current-state projection. It cannot reconstruct overwritten historical revisions. */
export async function getMembershipAccessEvidence(
  userId: string | null,
  since: string | null,
  asOf: string
): Promise<MembershipAccessEvidence> {
  const schema = await getSchema();
  if (!schema.tables.analytics_membership_access_signals)
    return {
      supported: false,
      signals: [],
      blind_spots: [
        'Membership access signal projection is unavailable; absence of client refresh events does not prove unchanged permissions.'
      ]
    };
  if (!userId)
    return {
      supported: true,
      signals: [],
      blind_spots: ['No authenticated subject for membership access signals.']
    };
  const rows = await query<{ team_id: string; revision: string | number; changed_at: string }>(
    `select team_id::text,revision::text,changed_at::text from public.analytics_membership_access_signals where user_id=$1::uuid and ($2::timestamptz is null or changed_at >= $2::timestamptz) and changed_at <= $3::timestamptz order by changed_at desc limit 101`,
    [userId, since, asOf]
  );
  const valid = rows
    .slice(0, 100)
    .filter(
      row =>
        /^[a-f0-9-]{36}$/i.test(row.team_id) &&
        (typeof row.revision === 'string'
          ? /^[1-9][0-9]{0,18}$/.test(row.revision)
          : Number.isSafeInteger(row.revision) && row.revision > 0) &&
        Number.isFinite(Date.parse(row.changed_at))
    );
  return {
    supported: true,
    signals: valid.map(row => ({
      ...row,
      revision: String(row.revision),
      browser_delivery: 'unknown'
    })),
    blind_spots: [
      'A durable revision proves signal production only. Correlated members.access_refresh attempts prove authoritative reread, while visible UI delivery needs separate browser evidence.',
      'Only current revisions at or before as-of are available; overwritten or later changes are not reconstructed.',
      ...(rows.length > 100 ? ['Membership signals truncated at 100 workspaces.'] : []),
      ...(valid.length !== Math.min(rows.length, 100)
        ? ['Malformed membership evidence was omitted; its outcome remains unknown.']
        : [])
    ]
  };
}
