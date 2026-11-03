import { query } from './db.js';
import { getSchema } from './schema.js';
export interface CommercialAccessRecord {
  id: string;
  team_id: string | null;
  kind: string;
  observed_at: string;
  needs_review: boolean | null;
  principal_bound: boolean | null;
  seats_used: number | null;
  seats_total: number | null;
}
export interface CommercialAccessEvidence {
  supported: boolean;
  records: CommercialAccessRecord[];
  blind_spots: string[];
}
export async function getCommercialAccessEvidence(
  owner: string | null,
  since: string | null,
  asOf: string
): Promise<CommercialAccessEvidence> {
  const schema = await getSchema();
  if (!schema.tables.analytics_commercial_access)
    return {
      supported: false,
      records: [],
      blind_spots: [
        'Commercial access journal is unavailable; Google approval, grant commit and migration capacity review are unknown.'
      ]
    };
  if (!owner)
    return {
      supported: true,
      records: [],
      blind_spots: ['No authenticated subject for commercial access evidence.']
    };
  const rows = await query<CommercialAccessRecord>(
    `select id::text,team_id::text,kind,observed_at::text,needs_review,principal_bound,seats_used,seats_total
     from public.analytics_commercial_access where owner_id=$1::uuid
     and ($2::timestamptz is null or observed_at >= $2::timestamptz) and observed_at <= $3::timestamptz
     order by observed_at desc,id limit 101`,
    [owner, since, asOf]
  );
  return {
    supported: true,
    records: rows.slice(0, 100),
    blind_spots: [
      'Journal records prove committed server state at their observed time, not current capacity, external payment, Google quota, consent completion or browser receipt. Rejected transactions leave no committed journal record; correlate the Google consent failure events separately.',
      ...(rows.length > 100 ? ['Commercial access journal truncated at 100 records.'] : [])
    ]
  };
}
