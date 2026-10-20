import { execFileSync } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';

// Only a running local stack or an explicitly isolated loopback test database.
// Never fall back to a linked/hosted project.
const isolatedUrl = process.env.SOTY_ISOLATED_DB_TYPES_URL;
if (isolatedUrl) {
  const url = new URL(isolatedUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/soty_tariff_test_[a-f0-9]{32}$/u.test(url.pathname)
  )
    throw new Error('ISOLATED_LOCAL_DATABASE_REQUIRED');
}
const generated = execFileSync(
  'npx',
  [
    'supabase',
    'gen',
    'types',
    'typescript',
    ...(isolatedUrl ? ['--db-url', isolatedUrl] : ['--local']),
    '--schema',
    'public'
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
);
if (!generated.includes('export type Database =')) throw new Error('INVALID_DATABASE_TYPES');
const types = `import type { Database } from './database.compat';
export type { Database, SupportGoalStatus, SupportGoalRow, Profile, AnalyticsEventRow, AdminUserRow, MarketingExportRow } from './database.compat';
${generated.replace('export type Database =', 'export type GeneratedDatabase =')}`;
const target = 'apps/web/src/lib/database.types.ts';
writeFileSync(`${target}.tmp`, types);
renameSync(`${target}.tmp`, target);
