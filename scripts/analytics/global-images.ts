import { query } from './db.js';
import { getSchema } from './schema.js';
import type { ResolvedPeriod } from './types.js';
import {
  isGlobalImageId,
  isGlobalImageCounter
} from '../../packages/shared/src/team/catalog-global-images.js';

export interface GlobalImageStatusOptions {
  image?: string;
  atLeast?: string;
  sort?: 'id' | 'uses';
  limit?: number;
  cursor?: string;
  cleanup?: boolean;
}
interface Cursor {
  v: 1;
  at: string;
  revision: string;
  environment: string | null;
  epoch: string;
  image: string | null;
  atLeast: string;
  sort: 'id' | 'uses';
  last: string;
  uses: string;
}
const cursorDecode = (raw: string): Cursor => {
  if (raw.length > 2048) throw new Error('Invalid global image cursor');
  let c: Cursor;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
  } catch {
    throw new Error('Invalid global image cursor');
  }
  if (
    c.v !== 1 ||
    !Number.isFinite(Date.parse(c.at)) ||
    typeof c.revision !== 'string' ||
    !isGlobalImageId(c.last) ||
    !isGlobalImageCounter(c.uses) ||
    !isGlobalImageCounter(c.epoch) ||
    !isGlobalImageCounter(c.atLeast) ||
    !['id', 'uses'].includes(c.sort) ||
    !(c.image === null || isGlobalImageId(c.image)) ||
    !(c.environment === null || ['dev', 'beta', 'production'].includes(c.environment))
  )
    throw new Error('Invalid global image cursor');
  return c;
};
export async function getGlobalImageStatus(
  period: ResolvedPeriod,
  options: GlobalImageStatusOptions = {}
) {
  const sort = options.sort ?? 'id',
    atLeast = options.atLeast ?? '0',
    limit = options.limit ?? 50;
  if (
    (options.image && !isGlobalImageId(options.image)) ||
    !isGlobalImageCounter(atLeast) ||
    !['id', 'uses'].includes(sort) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error(
      'Expected image UUID, exact nonnegative use threshold, sort id|uses and limit1..100'
    );
  const schema = await getSchema();
  if (
    !schema.tables.analytics_catalog_global_images ||
    !schema.tables.analytics_catalog_global_policy ||
    !schema.tables.analytics_catalog_global_cleanup
  )
    return {
      supported: false,
      status: 'projection_unavailable',
      blind_spots: [
        'Global pool projections are absent or the SELECT-only role lacks their narrow grants.'
      ]
    };
  const cursor = options.cursor ? cursorDecode(options.cursor) : null;
  if (
    cursor &&
    (cursor.sort !== sort ||
      cursor.atLeast !== atLeast ||
      cursor.image !== (options.image ?? null) ||
      Date.now() - Date.parse(cursor.at) > 60_000 ||
      Date.parse(cursor.at) > Date.now() + 1000)
  )
    return {
      supported: true,
      status: 'cursor_stale',
      partial: true,
      images: [],
      next_cursor: null
    };
  const observedAt = cursor?.at ?? new Date().toISOString();
  // One statement is one MVCC snapshot, including summary, tuple fingerprint, page and cleanup.
  const [row] = await query<{
    data: {
      policy: Record<string, unknown>;
      summary: Record<string, unknown>;
      images: Record<string, unknown>[];
      cleanup: Record<string, unknown>;
      revision: string;
    };
  }>(
    `
 with all_images as materialized(select * from public.analytics_catalog_global_images),
 policy as materialized(select * from public.analytics_catalog_global_policy),
 source as(select encode(sha256(convert_to(coalesce((select string_agg(to_jsonb(i)::text,',' order by image_id) from all_images i),'')||coalesce((select to_jsonb(p)::text from policy p),''),'UTF8')),'hex') revision),
 eligible as(select i.* from all_images i where ($1::uuid is null or image_id=$1) and confirmed_uses_total::bigint >= $2::bigint),
 page as(select * from eligible where $3::uuid is null or
  ($4='id' and image_id>$3) or ($4='uses' and (confirmed_uses_total::bigint<$5::bigint or (confirmed_uses_total::bigint=$5::bigint and image_id>$3)))
  order by case when $4='uses' then confirmed_uses_total::bigint end desc,image_id limit $6),
 cleanup as(select count(*) total,count(*) filter(where state='retained') retained,count(*) filter(where state='pending') pending,
  count(*) filter(where state='verified_deleted') deleted,count(*) filter(where external_untouched) external_untouched,
  count(*) filter(where state='unknown') unknown,count(*) filter(where state not in('verified_deleted','metadata_unlinked') and delete_after<=$7::timestamptz) overdue,
  min(delete_after) filter(where state not in('verified_deleted','metadata_unlinked')) oldest_due from public.analytics_catalog_global_cleanup)
 select jsonb_build_object('revision',(select revision from source),'policy',(select to_jsonb(p) from policy p),
 'summary',(select jsonb_build_object('total',count(*),'ready',count(*) filter(where active and state='ready' and content_expires_at>$7::timestamptz),
  'unknown',count(*) filter(where state='unknown'),'confirmed_uses_total',coalesce(sum(confirmed_uses_total::numeric),0)::text,'issued_slots_total',coalesce(sum(issued_slots_total::numeric),0)::text,
  'images_at_least_5000',count(*) filter(where confirmed_uses_total::bigint>=5000),'observed_since',min(created_at),'fresh_through',max(content_verified_at)) from all_images),
 'images',coalesce((select jsonb_agg(to_jsonb(p) order by case when $4='uses' then confirmed_uses_total::bigint end desc,image_id) from page p),'[]'::jsonb),
 'cleanup',(select to_jsonb(c) from cleanup c)) data`,
    [
      options.image ?? null,
      atLeast,
      cursor?.last ?? null,
      sort,
      cursor?.uses ?? '0',
      limit + 1,
      observedAt
    ]
  );
  if (!row?.data || !row.data.policy || !Array.isArray(row.data.images))
    throw new Error('Invalid global image status projection');
  const data = row.data;
  if (
    cursor &&
    (cursor.revision !== data.revision ||
      cursor.environment !== data.policy.environment ||
      cursor.epoch !== data.policy.policy_epoch)
  )
    return {
      supported: true,
      status: 'cursor_stale',
      partial: true,
      images: [],
      next_cursor: null
    };
  const historical = Boolean(period.as_of),
    more = data.images.length > limit,
    images = data.images.slice(0, limit),
    last = images.at(-1);
  const next =
    more && last
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            at: observedAt,
            revision: data.revision,
            environment: data.policy.environment as string | null,
            epoch: String(data.policy.policy_epoch),
            image: options.image ?? null,
            atLeast,
            sort,
            last: String(last.image_id),
            uses: String(last.confirmed_uses_total)
          } satisfies Cursor)
        ).toString('base64url')
      : null;
  return {
    supported: true,
    status: historical ? 'historical_unknown' : 'current_observation',
    scope: 'global_all_time_catalog_image_pairs',
    observed_at: observedAt,
    policy: data.policy,
    threshold: 5000,
    threshold_blocks: false,
    summary: historical ? null : data.summary,
    images: historical || options.cleanup ? [] : images,
    cleanup: data.cleanup,
    next_cursor: historical || options.cleanup ? null : next,
    truncated: more && !options.cleanup,
    source_revision: data.revision,
    blind_spots: [
      'Counters measure confirmed catalog+image pairs; they do not measure ad impressions or prove Facebook ingestion.',
      'Mutable counters are a current observation; historical state is not reconstructed.',
      'Anonymous delivery health proves a point-in-time check; provider cache and client visibility require separate acceptance.'
    ]
  };
}
export async function getGlobalImageEvidence(id: string, period: ResolvedPeriod) {
  if (!isGlobalImageId(id)) throw new Error('Expected global image, catalog, flow or attempt UUID');
  const schema = await getSchema();
  if (!schema.tables.analytics_catalog_global_journal)
    return { supported: false, evidence: [], blind_spots: ['Global journal is unavailable.'] };
  const evidence = await query<Record<string, unknown>>(
    `select evidence_id,flow_id,attempt_id,catalog_id,image_id,alias_id,stage,code,occurred_at,received_at,counts from public.analytics_catalog_global_journal
 where ($1::uuid in(flow_id,attempt_id,team_id,catalog_id,image_id,alias_id)) and occurred_at<=$2::timestamptz and ($3::timestamptz is null or occurred_at>=$3) order by occurred_at desc,evidence_id desc limit 101`,
    [id, period.end, period.start]
  );
  return {
    supported: true,
    evidence: evidence.slice(0, 100),
    truncated: evidence.length > 100,
    last_proven_stage: evidence[0]?.stage ?? null,
    blind_spots: evidence.length
      ? []
      : ['No retained correlated evidence; absence does not prove success or zero usage.']
  };
}
export async function getOwnedGlobalImageEvidence(userId: string | null, period: ResolvedPeriod) {
  const schema = await getSchema();
  if (!userId || !schema.tables.analytics_catalog_global_journal)
    return {
      supported: false,
      evidence: [],
      blind_spots: ['Global actor capture is unavailable; unknown ownership is never inferred.']
    };
  const evidence = await query<Record<string, unknown>>(
    `select evidence_id,flow_id,attempt_id,catalog_id,image_id,alias_id,stage,code,occurred_at,received_at,counts from public.analytics_catalog_global_journal where actor_id=$1::uuid and received_at<=$2::timestamptz and ($3::timestamptz is null or received_at>=$3) order by received_at desc,evidence_id desc limit 101`,
    [userId, period.end, period.start]
  );
  return {
    supported: true,
    evidence: evidence.slice(0, 100),
    truncated: evidence.length > 100,
    blind_spots: evidence.length ? [] : ['No retained global actor evidence; absence is unknown.']
  };
}
export async function getGlobalImageAudit(period: ResolvedPeriod) {
  const schema = await getSchema();
  if (
    !schema.tables.analytics_catalog_global_coverage ||
    !schema.tables.analytics_catalog_global_journal
  )
    return {
      supported: false,
      samples: 0,
      missing: ['global_image_projection_unavailable'],
      retiredEpoch: null
    };
  const health = await query<{ capture_enabled: boolean }>(
    'select capture_enabled from public.analytics_catalog_global_coverage'
  );
  const stages = await query<{ stage: string; samples: number }>(
    `select stage,count(*)::int samples from public.analytics_catalog_global_journal where received_at<=$1::timestamptz and ($2::timestamptz is null or received_at>=$2) group by stage`,
    [period.end, period.start]
  );
  const missing = health[0]?.capture_enabled === true ? [] : ['global_image_capture_unverified'];
  const [policy] = schema.tables.analytics_catalog_global_policy
    ? await query<{ policy_epoch: string; activated_at: string | null }>(
        'select policy_epoch,activated_at from public.analytics_catalog_global_policy'
      )
    : [];
  const retiredEpoch =
    policy?.activated_at && Date.parse(policy.activated_at) <= Date.parse(period.end)
      ? policy.policy_epoch
      : null;
  if (!stages.some(row => row.stage === 'confirmed'))
    missing.push('global_image_delivery_unobserved');
  if (stages.some(row => row.stage === 'unknown')) missing.push('global_image_unknown_stage');
  return {
    supported: true,
    samples: stages.reduce((sum, row) => sum + row.samples, 0),
    missing,
    retiredEpoch
  };
}
