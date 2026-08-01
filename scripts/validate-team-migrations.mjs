import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migrations = [
  'supabase/migrations/20260801090000_team_contract_seed.sql',
  'supabase/migrations/20260801091000_teams_members_invitations.sql',
  'supabase/migrations/20260801092000_drive_vault_catalog.sql',
  'supabase/migrations/20260801093000_team_operations_audit.sql',
  'supabase/migrations/20260801094000_team_security_foundation.sql'
];

const db = await PGlite.create();
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.profiles (
      id uuid primary key references auth.users(id),
      display_name text,
      account_status text not null default 'active'
    );
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
    create publication supabase_realtime;
  `);

  for (const file of migrations) {
    let sql = readFileSync(file, 'utf8');
    if (file.endsWith('20260801091000_teams_members_invitations.sql')) {
      sql = sql
        .replace('create extension if not exists citext with schema extensions;', '')
        .replaceAll('extensions.citext', 'text');
    }
    try {
      await db.exec(sql);
    } catch (error) {
      const position = Number(error?.position ?? 0);
      const context = position > 0 ? sql.slice(Math.max(0, position - 180), position + 180) : '';
      process.stderr.write(
        `Team migration validation failed in ${file}:\n${String(error)}\n${context}\n`
      );
      process.exitCode = 1;
      break;
    }
  }
  if (!process.exitCode) process.stdout.write('Team foundation migrations parse successfully.\n');
} finally {
  await db.close();
}
