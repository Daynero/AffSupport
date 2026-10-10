import { afterAll, describe, expect, it } from 'vitest';
import { runAttempt } from './support/adversarial.js';
import {
  ACTOR,
  MATERIAL_A,
  TEAM_A,
  closeTransferGrantDatabase,
  ticketHash,
  transferGrantSuite
} from './support/adversarial/transfer-grants.js';

/**
 * C9 (FR-031). Forged, replayed, expired and wrong-team tickets are all refused on the
 * unauthenticated backend range paths.
 *
 * The grant decisions run in the real migration SQL (PGlite) behind the edge function's real
 * `authorizePreviewRange`; see `tests/support/adversarial/transfer-grants.ts` for exactly what
 * is real and what is a stand-in. The attempts are shared with
 * `tests/adversarial-suite-size.test.ts`, which counts them.
 */

afterAll(async () => {
  await closeTransferGrantDatabase();
});

describe('every hostile ticket is refused', () => {
  it.each(transferGrantSuite.attempts.map(attempt => [attempt.name, attempt] as const))(
    '%s',
    async (_name, attempt) => {
      const result = await runAttempt(transferGrantSuite, attempt);
      expect(result.refused, result.evidence).toBe(true);
    },
    30_000
  );
});

describe('the legitimate ticket still works', () => {
  it('authorizes a freshly issued preview ticket for its own material', async () => {
    const target = await transferGrantSuite.start();
    try {
      const ticket = await target.issue({});
      const result = await target.range(ticket);
      expect(result.refused, result.evidence).toBe(false);
      expect(result.evidence).toContain(TEAM_A);
    } finally {
      await target.stop();
    }
  });

  it('serves a multi-use preview ticket for as many ranges as it was minted for', async () => {
    // A video seeks: one preview really is many range requests, which is why preview grants
    // are not single-use. The budget still ends.
    const target = await transferGrantSuite.start();
    try {
      const ticket = await target.issue({ maxUses: 3 });
      for (let use = 0; use < 3; use += 1) expect((await target.range(ticket)).refused).toBe(false);
      expect((await target.range(ticket)).refused).toBe(true);
    } finally {
      await target.stop();
    }
  });

  it('counts a use only when the ticket is accepted', async () => {
    const target = await transferGrantSuite.start();
    try {
      const ticket = await target.issue({ maxUses: 1 });
      // A wrong-purpose probe must not burn the ticket for its owner.
      expect(await target.consume(ticket, 'process_output')).toBeNull();
      const uses = await target.db.query<{ uses: number }>(
        'select uses from private.team_transfer_grants where token_hash = $1::text::bytea',
        [ticketHash(ticket)]
      );
      expect(uses.rows[0]?.uses).toBe(0);
      expect((await target.range(ticket)).refused).toBe(false);
    } finally {
      await target.stop();
    }
  });

  it('refuses to mint a grant that is already expired', async () => {
    const target = await transferGrantSuite.start();
    try {
      await expect(target.issue({ expiresInMs: -1_000 })).rejects.toThrow(/INVALID_TRANSFER_GRANT/);
    } finally {
      await target.stop();
    }
  });

  it('keeps tickets out of the table: only a 32-byte hash is stored', async () => {
    const target = await transferGrantSuite.start();
    try {
      const ticket = await target.issue({});
      const stored = await target.db.query<{
        token_hash: Uint8Array;
        actor_id: string;
        material_id: string;
      }>('select token_hash, actor_id, material_id from private.team_transfer_grants');
      const row = stored.rows[0]!;
      expect(row.token_hash.byteLength).toBe(32);
      expect(Buffer.from(row.token_hash).toString('utf8')).not.toContain(ticket);
      expect([row.actor_id, row.material_id]).toEqual([ACTOR, MATERIAL_A]);
    } finally {
      await target.stop();
    }
  });
});
