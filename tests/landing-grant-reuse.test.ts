import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import {
  landingReuseKey,
  landingTicket
} from '../supabase/functions/drive-transfer/landing-ticket.ts';

it('reconstructs opaque tickets, separates IDs and keys, and never exposes the secret', async () => {
  const id = randomUUID();
  const ticket = await landingTicket('secret-a', id);
  expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(await landingTicket('secret-a', id)).toBe(ticket);
  expect(await landingTicket('secret-b', id)).not.toBe(ticket);
  expect(await landingTicket('secret-a', randomUUID())).not.toBe(ticket);
  expect(await landingReuseKey('secret-a')).toMatch(/^[a-f0-9]{64}$/u);
  expect(await landingReuseKey('secret-a')).not.toBe(await landingReuseKey('secret-b'));
});

it('reuses only idle matching grants without extending expiry or resetting the eight-use limit', async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      create schema private;
      create role anon; create role authenticated; create role service_role;
      create table public.permissions(allowed boolean not null);
      insert into public.permissions values(true);
      create function private.can(uuid,text,uuid) returns boolean language sql
        as 'select allowed from public.permissions';
      create table private.team_transfer_grants (
        id uuid primary key, token_hash bytea unique not null,
        operation_id uuid, team_id uuid not null, actor_id uuid not null,
        purpose text not null, material_id uuid, destination_folder_id uuid,
        tool_id text, max_range_bytes integer not null, expires_at timestamptz not null,
        revoked_at timestamptz, uses integer not null default 0,
        max_uses integer not null default 1, created_at timestamptz not null default now()
      );
    `);
    const foundation = await readFile(
      'supabase/migrations/20260801094000_team_security_foundation.sql',
      'utf8'
    );
    const consume = foundation.slice(
      foundation.indexOf('create or replace function private.consume_team_transfer_grant('),
      foundation.indexOf('create or replace function private.revoke_team_transfer_grants(')
    );
    await db.exec(consume);
    await db.exec(
      await readFile('supabase/migrations/20261202120000_landing_grant_reuse.sql', 'utf8')
    );
    const team = randomUUID(),
      actor = randomUUID(),
      material = randomUUID();
    const tool = `landing-render:${randomUUID()}:0`;
    const key = await landingReuseKey('secret-a');
    const issue = async (
      overrides: { actor?: string; material?: string; tool?: string; key?: string } = {}
    ) => {
      const id = randomUUID();
      const ticket = await landingTicket('secret-a', id);
      const hash = '\\x' + createHash('sha256').update(ticket).digest('hex');
      const result = (
        await db.query<{ grant_id: string; expires_at: string }>(
          'select * from public.issue_landing_preview_grant($1,$2::text::bytea,$3,$4,$5,$6,$7,$8)',
          [
            id,
            hash,
            overrides.key ?? key,
            team,
            overrides.actor ?? actor,
            overrides.material ?? material,
            overrides.tool ?? tool,
            262144
          ]
        )
      ).rows[0]!;
      return { ...result, ticket: await landingTicket('secret-a', result.grant_id) };
    };
    const first = await issue();
    const reused = await issue();
    expect(reused).toEqual(first);
    const parallel = await Promise.all(Array.from({ length: 12 }, () => issue()));
    expect(parallel.every(grant => grant.grant_id === first.grant_id)).toBe(true);
    for (let i = 0; i < 60; i++) expect((await issue()).grant_id).toBe(first.grant_id);
    expect((await db.query('select id from private.team_transfer_grants')).rows).toHaveLength(1);
    for (const overrides of [
      { actor: randomUUID() },
      { material: randomUUID() },
      { tool: `landing-render:${randomUUID()}:1` },
      { key: await landingReuseKey('secret-b') }
    ])
      expect((await issue(overrides)).grant_id).not.toBe(first.grant_id);
    expect(new Date(first.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(20 * 60 * 1000);
    const hash = '\\x' + createHash('sha256').update(first.ticket).digest('hex');
    const consumeTicket = async () =>
      (
        await db.query(
          "select * from private.consume_team_transfer_grant($1::text::bytea, 'preview_range')",
          [hash]
        )
      ).rows;
    expect(await consumeTicket()).toHaveLength(1);
    expect((await issue()).grant_id).not.toBe(first.grant_id);
    for (let i = 1; i < 8; i++) expect(await consumeTicket()).toHaveLength(1);
    expect(await consumeTicket()).toHaveLength(0);
    await db.exec('update public.permissions set allowed = false');
    await expect(issue()).rejects.toThrow('PERMISSION_DENIED');
    expect(await consumeTicket()).toHaveLength(0);
    await db.exec('update public.permissions set allowed = true');
    const revoked = await issue();
    const revokedHash = '\\x' + createHash('sha256').update(revoked.ticket).digest('hex');
    await db.query('update private.team_transfer_grants set revoked_at = now() where id = $1', [
      revoked.grant_id
    ]);
    expect((await issue()).grant_id).not.toBe(revoked.grant_id);
    expect(
      (
        await db.query(
          "select * from private.consume_team_transfer_grant($1::text::bytea, 'preview_range')",
          [revokedHash]
        )
      ).rows
    ).toHaveLength(0);
    const nearingExpiry = await issue();
    await db.query(
      "update private.team_transfer_grants set expires_at = now() + interval '1 minute' where id = $1",
      [nearingExpiry.grant_id]
    );
    expect((await issue()).grant_id).not.toBe(nearingExpiry.grant_id);
    for (const role of ['anon', 'authenticated']) {
      expect(
        (
          await db.query<{ allowed: boolean }>(
            "select has_function_privilege($1, 'public.issue_landing_preview_grant(uuid,bytea,text,uuid,uuid,uuid,text,integer)', 'EXECUTE') as allowed",
            [role]
          )
        ).rows[0]?.allowed
      ).toBe(false);
    }
  } finally {
    await db.close();
  }
}, 30_000);
