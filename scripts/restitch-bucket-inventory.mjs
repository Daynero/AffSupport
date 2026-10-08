#!/usr/bin/env node
/**
 * What the legacy media buckets still hold (feature 030, T050). Read-only.
 *
 * Lists every object in `team-restitch-images` and `team-thumbnail-cache` through the Storage
 * API with the service key, grouped by space and by the member who published it, and prints
 * one JSON document to stdout. It never removes, renames or writes anything: the deletion in
 * `supabase/migrations/20261105100000_restitch_bucket_retirement.sql` is written from this
 * output by hand, and approved object by object.
 *
 * Usage:
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/restitch-bucket-inventory.mjs [--bucket team-restitch-images]
 */
import { createClient } from '@supabase/supabase-js';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (read-only use)');

const only = (() => {
  const index = process.argv.indexOf('--bucket');
  return index >= 0 ? process.argv[index + 1] : null;
})();
const buckets = (only ? [only] : ['team-restitch-images', 'team-thumbnail-cache']).filter(Boolean);

const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** Every object under a prefix, walking "folders" the Storage API reports, page by page. */
async function walk(bucket, prefix = '') {
  const found = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await client.storage
      .from(bucket)
      .list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) fail(`${bucket}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder entry has no id; an object does.
      if (entry.id)
        found.push({
          path,
          size: entry.metadata?.size ?? null,
          updatedAt: entry.updated_at ?? null
        });
      else found.push(...(await walk(bucket, path)));
    }
    if (data.length < 1000) break;
    offset += data.length;
  }
  return found;
}

const report = { generatedAt: new Date().toISOString(), readOnly: true, buckets: {} };
for (const bucket of buckets) {
  const objects = await walk(bucket);
  const bySpace = {};
  for (const object of objects) {
    const [team, user] = object.path.split('/');
    const space = (bySpace[team] ??= { count: 0, bytes: 0, byUser: {} });
    space.count += 1;
    space.bytes += object.size ?? 0;
    if (user) {
      const member = (space.byUser[user] ??= { count: 0, bytes: 0 });
      member.count += 1;
      member.bytes += object.size ?? 0;
    }
  }
  report.buckets[bucket] = {
    count: objects.length,
    bytes: objects.reduce((sum, object) => sum + (object.size ?? 0), 0),
    bySpace,
    objects
  };
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(
  `inventory: ${buckets.map(bucket => `${bucket}=${report.buckets[bucket].count}`).join(', ')} objects (read-only)\n`
);
