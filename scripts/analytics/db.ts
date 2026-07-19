import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

// Numeric-ish Postgres OIDs (bigint, numeric) come back as strings by default to
// avoid precision loss. Our aggregates fit safely in a JS number, so parse them.
pg.types.setTypeParser(20, value => (value === null ? null : Number(value))); // int8 / bigint
pg.types.setTypeParser(1700, value => (value === null ? null : Number(value))); // numeric

const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|comment|copy|merge|call|do|vacuum|reindex|refresh|set|reset|lock)\b/i;

/**
 * Defense in depth: every query the CLI runs is a hand-written SELECT, but we
 * still reject anything that could mutate state or smuggle in a second
 * statement. The dedicated role is already SELECT-only and read-only; this guard
 * makes a future copy-paste mistake fail loudly at the call site instead.
 */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    throw new Error('Refusing multi-statement SQL in the read-only analytics CLI.');
  }
  const lowered = trimmed.toLowerCase();
  if (!lowered.startsWith('select') && !lowered.startsWith('with')) {
    throw new Error('Analytics CLI only runs SELECT/WITH queries.');
  }
  if (WRITE_KEYWORDS.test(trimmed)) {
    throw new Error('Refusing SQL containing a write/DDL keyword in the read-only analytics CLI.');
  }
}

function loadEnvFiles(): void {
  // tsx does not auto-load .env; do it ourselves without adding a dependency.
  // Later files win, matching Vite's precedence (.env then .env.local).
  const candidates = ['.env', '.env.local'];
  for (const file of candidates) {
    const path = resolve(process.cwd(), file);
    if (existsSync(path) && typeof process.loadEnvFile === 'function') {
      try {
        process.loadEnvFile(path);
      } catch {
        // A malformed optional env file should not crash the CLI.
      }
    }
  }
}

let pool: pg.Pool | null = null;

export function connectionString(): string {
  loadEnvFiles();
  const url = process.env.ANALYTICS_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'ANALYTICS_DATABASE_URL is not set. See docs/ANALYTICS_CLI.md for how to create the ' +
        'read-only role and build the connection string, then add it to your .env.'
    );
  }
  return url;
}

function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: connectionString(),
    max: 3,
    // Force a read-only, time-bounded session regardless of the role's own
    // defaults, so writes are impossible even if the URL points at a wider role.
    options: '-c default_transaction_read_only=on -c statement_timeout=30000',
    ssl: process.env.ANALYTICS_DB_NO_SSL === '1' ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000
  });
  return pool;
}

/** Pluggable executor so tests can run the exact queries against an in-process
 *  Postgres. Production always uses the pooled read-only connection below. */
export type QueryExecutor = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
let executorOverride: QueryExecutor | null = null;

export function setQueryExecutor(executor: QueryExecutor | null): void {
  executorOverride = executor;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  assertReadOnlySql(sql);
  if (executorOverride) return (await executorOverride(sql, params)) as T[];
  const result = await getPool().query(sql, params as never[]);
  return result.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
