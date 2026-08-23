import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/**
 * A real Postgres (PGlite/wasm) with the repository's migrations applied, for
 * testing SQL functions the way callers actually reach them: through
 * `security definer` boundaries, with `auth.uid()` set to a specific person.
 *
 * The whole chain applies in well under a second, so each suite gets its own
 * database and no test has to clean up after another.
 */

const MIGRATIONS_DIR = 'supabase/migrations';

/**
 * Supabase provides these; a bare Postgres does not. They are stubs, not
 * reimplementations — each exists only so a migration that references it can
 * parse and run. A test that depends on the *behavior* of one of these (Vault
 * encryption, cron scheduling, storage policies) is testing Supabase, not this
 * repository, and belongs in the pgTAP suite instead.
 */
const SUPABASE_STUBS = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    email_confirmed_at timestamptz,
    last_sign_in_at timestamptz,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create schema extensions;
  -- pgcrypto is not bundled with PGlite. Only digest() is reached from a
  -- migration (an analytics workspace key), and only its shape matters here, so
  -- md5 stands in. Nothing in these tests asserts on the digest value.
  create function extensions.digest(text, text) returns bytea language sql immutable
  as $$ select decode(md5($1), 'hex') $$;
  create function extensions.digest(bytea, text) returns bytea language sql immutable
  as $$ select decode(md5($1), 'hex') $$;
  create function extensions.gen_random_bytes(integer) returns bytea language sql volatile
  as $$ select decode(repeat(md5(random()::text), ($1 / 16) + 1), 'hex') $$;

  create schema vault;
  create table vault.secrets (
    id uuid primary key default gen_random_uuid(),
    secret text not null,
    name text,
    description text
  );
  create view vault.decrypted_secrets as
    select id, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(text, text, text) returns uuid language plpgsql
  as $$ declare created uuid; begin
    insert into vault.secrets(secret, name, description) values ($1, $2, $3)
    returning id into created; return created;
  end $$;
  create function vault.update_secret(uuid, text) returns void language sql
  as $$ update vault.secrets set secret = $2 where id = $1 $$;
  create function vault.delete_secret(uuid) returns void language sql
  as $$ delete from vault.secrets where id = $1 $$;

  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text,
    name text,
    owner uuid
  );

  create schema net;
  create function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)
  returns bigint language sql as $$ select 0::bigint $$;

  create schema cron;
  create table cron.job (jobid bigint primary key, jobname text);
  create function cron.schedule(text, text, text) returns bigint language sql
  as $$ select 0::bigint $$;
  create function cron.unschedule(bigint) returns boolean language sql
  as $$ select true $$;

  create publication supabase_realtime;
`;

/** Rewrites that let a production migration run outside Supabase. */
function portable(sql: string): string {
  return (
    sql
      // citext lives in a Supabase-managed extensions schema; the columns using
      // it are compared case-insensitively by the functions themselves.
      .replace(/create extension if not exists citext with schema extensions;/g, '')
      .replaceAll('extensions.citext', 'text')
      // pg_cron and pg_net cannot be installed into PGlite; the stub schemas
      // above stand in for the scheduler and the outbound HTTP call.
      .replace(/create extension if not exists pg_cron with schema pg_catalog;/g, '')
      .replace(/create extension if not exists pg_net with schema extensions;/g, '')
  );
}

export interface TeamTestDb {
  db: PGlite;
  /** Run SQL as a given user, exactly as PostgREST would set the JWT claim. */
  asUser: <T = Record<string, unknown>>(
    userId: string | null,
    sql: string,
    params?: unknown[]
  ) => Promise<T[]>;
  /** Run SQL with no authenticated user and full privileges (fixtures). */
  root: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

export async function createTeamTestDb(): Promise<TeamTestDb> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUBS);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = portable(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${file} failed to apply: ${String(error)}`, { cause: error });
    }
  }

  const root = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const result = await db.query<T>(sql, params);
    return result.rows;
  };

  const asUser = async <T = Record<string, unknown>>(
    userId: string | null,
    sql: string,
    params: unknown[] = []
  ) => {
    // set_config's third argument is `is_local`; false keeps the claim for the
    // rest of the session, which is what a PostgREST request looks like.
    await db.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', userId ?? '']);
    try {
      const result = await db.query<T>(sql, params);
      return result.rows;
    } finally {
      await db.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', '']);
    }
  };

  return { db, root, asUser, close: () => db.close() };
}

/** Create a confirmed account the team functions will accept as an actor. */
export async function createUser(
  harness: TeamTestDb,
  input: { id: string; email: string; displayName?: string }
): Promise<string> {
  await harness.root(
    `insert into auth.users (id, email, email_confirmed_at, last_sign_in_at)
     values ($1, $2, now(), now())`,
    [input.id, input.email]
  );
  await harness.root(
    `insert into public.profiles (id, display_name, account_status)
     values ($1, $2, 'active')
     on conflict (id) do update set display_name = excluded.display_name`,
    [input.id, input.displayName ?? input.email]
  );
  return input.id;
}
