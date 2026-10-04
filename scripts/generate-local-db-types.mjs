import { execFileSync } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';

// Only a running local stack can provide the schema; never fall back to --linked.
const generated = execFileSync(
  'npx',
  ['supabase', 'gen', 'types', 'typescript', '--local', '--schema', 'public'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
);
if (!generated.includes('export type Database =')) throw new Error('INVALID_DATABASE_TYPES');
const types = `import type { Database } from './database.compat';
export type { Database, SupportGoalStatus, SupportGoalRow, Profile, AnalyticsEventRow, AdminUserRow, MarketingExportRow } from './database.compat';
${generated.replace('export type Database =', 'export type GeneratedDatabase =')}`;
const target = 'apps/web/src/lib/database.types.ts';
writeFileSync(`${target}.tmp`, types);
renameSync(`${target}.tmp`, target);
