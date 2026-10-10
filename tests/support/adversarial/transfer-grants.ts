import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  authorizePreviewRange,
  type PreviewGrantContext,
  type PreviewMaterialRecord
} from '../../../supabase/functions/drive-transfer/handler.ts';
import { outcome, type AdversarialSuite, type AttemptOutcome } from '../adversarial.js';

/**
 * C9. The one unauthenticated data path in the backend: `drive-transfer`'s `/range`,
 * `/render-range` and `/thumbnail` run with `verify_jwt = false` and rely entirely on a
 * transfer grant ticket.
 *
 * What decides a ticket is the database: `consume_team_transfer_grant` looks it up by hash,
 * checks purpose, revocation, expiry and uses, re-checks the actor's permission in the team,
 * and counts the use. So these attempts run the **real function bodies from the migrations**
 * in PGlite — the newest definition of each, found by scanning the migration folder the way
 * the database applies it — and drive them through the edge function's real
 * `authorizePreviewRange`. The only stand-ins are the tables the grant references and
 * `private.can`, which is reduced to a membership lookup; the grant logic itself is not
 * re-described anywhere in this file.
 */

const MIGRATIONS = 'supabase/migrations';

export const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const MATERIAL_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const MATERIAL_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** Same shape as drive-transfer's `randomTicket`: 32 random bytes, base64url. */
export function randomTicket(): string {
  return randomBytes(32).toString('base64url');
}

/** Same encoding as drive-transfer's `byteaHex(await sha256(ticket))`. */
export function ticketHash(ticket: string): string {
  return `\\x${createHash('sha256').update(ticket).digest('hex')}`;
}

/** The newest `create or replace function <name>(` across the migrations, body included. */
async function latestFunctionDefinition(name: string): Promise<string> {
  const files = (await readdir(MIGRATIONS)).filter(file => file.endsWith('.sql')).sort();
  const pattern = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${name.replace('.', '\\.')}\\(`,
    'gi'
  );
  let latest: string | null = null;
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS, file), 'utf8');
    for (const match of sql.matchAll(pattern)) {
      const start = match.index!;
      const opening = /\bas\s+(\$[a-z_]*\$)/gi;
      opening.lastIndex = start;
      const tag = opening.exec(sql);
      if (!tag) throw new Error(`${name} in ${file} has no dollar-quoted body`);
      const close = sql.indexOf(tag[1]!, tag.index + tag[0].length);
      const end = sql.indexOf(';', close);
      latest = sql.slice(start, end + 1);
    }
  }
  if (!latest) throw new Error(`${name} is not defined by any migration`);
  return latest;
}

/** One SQL statement from one migration, from its first words to the next `;`. */
async function statement(file: string, startsWith: string, occurrence = 0): Promise<string> {
  const sql = await readFile(path.join(MIGRATIONS, file), 'utf8');
  let from = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    from = sql.indexOf(startsWith, from + 1);
    if (from === -1) throw new Error(`${startsWith} not found in ${file}`);
  }
  // The table body has nested parentheses and `;` never appears inside it.
  return sql.slice(from, sql.indexOf(';\n', from) + 1);
}

let database: Promise<PGlite> | null = null;

async function createDatabase(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(`
    create schema private;
    create role anon; create role authenticated; create role service_role;
    create table public.teams (id uuid primary key);
    create table public.team_materials (id uuid primary key, team_id uuid not null);
    create table public.team_operations (id uuid primary key, team_id uuid, actor_id uuid);
    create table private.stub_permissions (
      team_id uuid not null, actor_id uuid not null, permission text not null
    );
    -- Stand-in for the real permission matrix: a row means the actor holds it, today.
    create function private.can(p_team uuid, p_permission text, p_actor uuid)
    returns boolean language sql stable as $$
      select exists (
        select 1 from private.stub_permissions
        where team_id = p_team and actor_id = p_actor and permission = p_permission
      );
    $$;
  `);
  await db.exec(
    await statement(
      '20260801093000_team_operations_audit.sql',
      'create table private.team_transfer_grants ('
    )
  );
  // 011 widened the purpose check for the thumbnail session.
  await db.exec(
    await statement(
      '20260827106000_team_thumbnail_session.sql',
      'alter table private.team_transfer_grants',
      0
    )
  );
  await db.exec(
    await statement(
      '20260827106000_team_thumbnail_session.sql',
      'alter table private.team_transfer_grants',
      1
    )
  );
  for (const name of [
    'private.issue_team_transfer_grant',
    'private.consume_team_transfer_grant',
    'public.consume_team_transfer_grant'
  ]) {
    await db.exec(await latestFunctionDefinition(name));
  }
  return db;
}

export async function closeTransferGrantDatabase(): Promise<void> {
  const pending = database;
  database = null;
  if (pending) await (await pending).close();
}

export interface GrantTarget {
  db: PGlite;
  /** Mints through the real issuer, the way drive-transfer does. */
  issue(input: {
    ticket?: string;
    team?: string;
    purpose?: string;
    material?: string | null;
    maxUses?: number;
    expiresInMs?: number;
  }): Promise<string>;
  /** drive-transfer's `consumeGrant`: the RPC, then the same row checks. */
  consume(ticket: string, purpose: string): Promise<PreviewGrantContext | null>;
  /** drive-transfer's `/range` authorization, with the database behind it. */
  range(ticket: string): Promise<AttemptOutcome>;
}

async function startGrantTarget(): Promise<GrantTarget & { stop(): Promise<void> }> {
  database ??= createDatabase();
  const db = await database;
  await db.exec(`
    truncate private.team_transfer_grants, private.stub_permissions, public.team_materials, public.teams;
    insert into public.teams values ('${TEAM_A}'), ('${TEAM_B}');
    insert into public.team_materials values ('${MATERIAL_A}', '${TEAM_A}'), ('${MATERIAL_B}', '${TEAM_B}');
    insert into private.stub_permissions
      select '${TEAM_A}', '${ACTOR}', permission
      from unnest(array['view', 'download', 'process', 'upload']) as permission;
  `);

  const consume: GrantTarget['consume'] = async (ticket, purpose) => {
    const result = await db.query<Record<string, unknown>>(
      'select * from public.consume_team_transfer_grant($1::text::bytea, $2)',
      [ticketHash(ticket), purpose]
    );
    const row = result.rows[0];
    if (!row) return null;
    const teamId = typeof row.team_id === 'string' ? row.team_id : null;
    const actorId = typeof row.actor_id === 'string' ? row.actor_id : null;
    const materialId = typeof row.material_id === 'string' ? row.material_id : null;
    const maxRangeBytes = Number.isSafeInteger(row.max_range_bytes)
      ? Number(row.max_range_bytes)
      : null;
    if (!teamId || !actorId || !materialId || maxRangeBytes === null) return null;
    return {
      teamId,
      actorId,
      materialId,
      maxRangeBytes,
      toolId: typeof row.tool_id === 'string' ? row.tool_id : null,
      purpose: purpose as PreviewGrantContext['purpose']
    };
  };

  /** drive-transfer's `consumeRangeGrant`: the three purposes a range may be read for. */
  async function consumeRangeGrant(ticket: string) {
    for (const purpose of ['preview_range', 'download_range', 'process_input'] as const) {
      const grant = await consume(ticket, purpose);
      if (grant) return grant;
    }
    return null;
  }

  return {
    db,
    async issue(input) {
      const ticket = input.ticket ?? randomTicket();
      const purpose = input.purpose ?? 'preview_range';
      await db.query(
        `select private.issue_team_transfer_grant(
           $1::text::bytea, null, $2::uuid, $3::uuid, $4, $5::uuid, null, null, 8388608,
           clock_timestamp() + ($6 || ' milliseconds')::interval, $7)`,
        [
          ticketHash(ticket),
          input.team ?? TEAM_A,
          ACTOR,
          purpose,
          input.material === undefined
            ? purpose === 'thumbnail_session'
              ? null
              : MATERIAL_A
            : input.material,
          String(input.expiresInMs ?? 20 * 60_000),
          input.maxUses ?? 512
        ]
      );
      return ticket;
    },
    consume,
    async range(ticket) {
      try {
        const authorized = await authorizePreviewRange(
          { ticket, rangeHeader: 'bytes=0-99' },
          {
            consumeGrant: consumeRangeGrant,
            // The material as the catalog holds it — including its real team, so a grant
            // that names another team's material is caught by the handler's own check.
            loadMaterial: async grant => {
              const found = await db.query<{ id: string; team_id: string }>(
                'select id, team_id from public.team_materials where id = $1',
                [grant.materialId]
              );
              const row = found.rows[0];
              return row ? materialRecord(row.id, row.team_id) : null;
            },
            proveLiveAccess: async () => ({
              fileId: 'drive-file',
              resourceKey: null,
              sizeBytes: 1_000,
              mimeType: 'video/mp4',
              canDownload: true
            })
          }
        );
        return outcome(
          false,
          `authorized ${authorized.grant.purpose} for team ${authorized.grant.teamId}`
        );
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return outcome(code === 'PERMISSION_DENIED', `refused: ${String(code ?? error)}`);
      }
    },
    async stop() {
      // The database is shared across attempts and truncated by the next start.
    }
  };
}

function materialRecord(materialId: string, teamId: string): PreviewMaterialRecord {
  return {
    teamId,
    materialId,
    driveFileId: 'drive-file',
    resourceKey: null,
    name: 'clip.mp4',
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    sizeBytes: 1_000,
    driveVersion: '1',
    checksum: null,
    previewState: 'ready',
    previewErrorCode: null,
    transcriptText: null,
    transcriptIngestState: 'not_applicable',
    transcriptTruncated: false,
    transcriptIndexedBytes: 0,
    transcriptSourceVersion: null,
    canDownload: true,
    canEdit: false
  } as PreviewMaterialRecord;
}

/** A use that must succeed for the attempt to mean anything; otherwise the attempt is void. */
async function legitimateUse(target: GrantTarget, ticket: string): Promise<AttemptOutcome | null> {
  const first = await target.range(ticket);
  return first.refused
    ? outcome(false, `the legitimate use was refused too (${first.evidence})`)
    : null;
}

export const transferGrantSuite: AdversarialSuite<GrantTarget> = {
  testFile: 'tests/transfer-grant-tickets.test.ts',
  start: startGrantTarget,
  attempts: [
    {
      name: 'a forged ticket of the right shape that was never issued',
      attempt: target => target.range(randomTicket())
    },
    {
      name: 'a forged ticket too short to be one',
      attempt: target => target.range('abc')
    },
    {
      name: 'a forged ticket far longer than any issued',
      attempt: target => target.range('A'.repeat(4096))
    },
    {
      name: 'the stored hash presented as if it were the ticket',
      async attempt(target) {
        const ticket = await target.issue({});
        // Someone who can read the grant table holds hashes, not tickets.
        return target.range(createHash('sha256').update(ticket).digest('hex'));
      }
    },
    {
      name: 'a real ticket with one byte changed',
      async attempt(target) {
        const ticket = await target.issue({});
        const flipped = `${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`;
        return target.range(flipped);
      }
    },
    {
      name: 'a single-use ticket replayed',
      async attempt(target) {
        const ticket = await target.issue({ maxUses: 1 });
        return (await legitimateUse(target, ticket)) ?? target.range(ticket);
      }
    },
    {
      name: 'a multi-use preview ticket replayed past its budget',
      async attempt(target) {
        const ticket = await target.issue({ maxUses: 512 });
        await target.db.query(
          'update private.team_transfer_grants set uses = max_uses - 1 where token_hash = $1::text::bytea',
          [ticketHash(ticket)]
        );
        return (await legitimateUse(target, ticket)) ?? target.range(ticket);
      }
    },
    {
      name: 'an expired ticket',
      async attempt(target) {
        const ticket = randomTicket();
        // The issuer refuses to mint an already-expired grant, so this one is aged in place.
        await target.db.query(
          `insert into private.team_transfer_grants
             (token_hash, team_id, actor_id, purpose, material_id, max_range_bytes,
              expires_at, max_uses, created_at)
           values ($1::text::bytea, $2, $3, 'preview_range', $4, 8388608,
                   now() - interval '1 second', 512, now() - interval '21 minutes')`,
          [ticketHash(ticket), TEAM_A, ACTOR, MATERIAL_A]
        );
        return target.range(ticket);
      }
    },
    {
      name: 'a revoked ticket',
      async attempt(target) {
        const ticket = await target.issue({});
        await target.db.query(
          'update private.team_transfer_grants set revoked_at = now() where token_hash = $1::text::bytea',
          [ticketHash(ticket)]
        );
        return target.range(ticket);
      }
    },
    {
      name: 'a ticket whose holder has since left the team',
      async attempt(target) {
        const ticket = await target.issue({});
        await target.db.query('delete from private.stub_permissions where actor_id = $1', [ACTOR]);
        return target.range(ticket);
      }
    },
    {
      name: "a ticket presented for another team's material",
      async attempt(target) {
        // A grant in team A that names team B's material — the binding the handler re-checks
        // against the catalog rather than trusting the grant row.
        const ticket = await target.issue({ material: MATERIAL_B });
        return target.range(ticket);
      }
    },
    {
      name: 'a ticket minted for a team the holder is not in',
      async attempt(target) {
        const ticket = await target.issue({ team: TEAM_B, material: MATERIAL_B });
        return target.range(ticket);
      }
    },
    {
      name: 'an upload ticket presented on the range path',
      async attempt(target) {
        const ticket = await target.issue({ purpose: 'process_output' });
        return target.range(ticket);
      }
    },
    {
      name: 'a thumbnail session presented on the range path',
      async attempt(target) {
        const ticket = await target.issue({ purpose: 'thumbnail_session' });
        return target.range(ticket);
      }
    },
    {
      name: 'a range ticket presented as a thumbnail session',
      async attempt(target) {
        const ticket = await target.issue({ purpose: 'preview_range' });
        // drive-transfer's `consumeSessionGrant` needs only a row back: a session names no
        // material, so the raw RPC result is what decides, not the range-shaped mapping.
        const rows = await target.db.query(
          "select * from public.consume_team_transfer_grant($1::text::bytea, 'thumbnail_session')",
          [ticketHash(ticket)]
        );
        return outcome(
          rows.rows.length === 0,
          rows.rows.length ? 'accepted as a session' : 'refused'
        );
      }
    }
  ]
};
