import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { register } from 'tsx/esm/api';
import { validateLocalTarget } from './target.mjs';
import {
  verifiedLocalStack,
  validateFixtureState,
  assertFixtureProvisionable
} from './fixtures.mjs';
import { readPrivateState } from './private-state.mjs';
import {
  lockTariffClockMutation,
  inspectTariffClockState,
  readClockFixtureSource
} from './clock-state.mjs';
import { storeNoticeCapture } from './mail-capture-store.mjs';

/** Internal transaction seam. The CLI verifies the local stack first; tests use a disposable DB.
 * The global production claim RPC is deliberately unchanged. Refuse ALL foreign pending
 * candidates before calling it, including leased candidates that could become due later.
 */
export async function captureVerifiedFixtureNotices(db, namespace, fixture, record) {
  let committing = false;
  let captured = 0;
  let captureUnconfirmed = 0;
  let captureTimedOut = false;
  let stage = 'worker';
  let idleDisconnected = false;
  const connectionError = error => {
    if (error?.code === '25P03') idleDisconnected = true;
  };
  db.on?.('error', connectionError);
  try {
    // Load the existing TypeScript worker before taking any database locks.
    const unregister = register();
    let runTariffNotices;
    try {
      const source = new URL('../../supabase/functions/tariff-notices/handler.ts', import.meta.url);
      ({ runTariffNotices } = await import(source.href));
    } finally {
      await unregister();
    }
    stage = 'clock';
    await db.query('begin');
    await db.query("set local statement_timeout='10s'");
    await db.query("set local lock_timeout='2s'");
    // PostgreSQL releases locks even if this process cannot execute its JS timer.
    await db.query("set local idle_in_transaction_session_timeout='15s'");
    await lockTariffClockMutation(db, namespace);
    stage = 'lifecycle';
    await assertFixtureProvisionable(namespace);
    stage = 'clock';
    const { body } = await readClockFixtureSource();
    await inspectTariffClockState(db, namespace, body);
    // Same lock order as tariff mutation, then its notice insertion.
    await db.query('lock table public.space_tariffs in share mode');
    await db.query('lock table public.space_tariff_notices in share row exclusive mode');
    stage = 'identity';
    const actorIds = Object.values(fixture.actors).map(actor => actor.id);
    for (const [alias, actor] of Object.entries(fixture.actors)) {
      const found = await db.query(
        "select id from auth.users where id=$1 and email=$2 and raw_user_meta_data->>'acceptance_namespace'=$3 for share",
        [actor.id, `${namespace}-${alias.toLowerCase()}@soty.invalid`, namespace]
      );
      if (found.rows.length !== 1) throw Error('ACTOR');
    }
    const owners = new Map();
    for (const [alias, actorAlias] of [
      ['W1', 'A'],
      ['W2', 'X']
    ]) {
      const id = fixture.actors[actorAlias].id;
      const found = await db.query(
        'select id from public.teams where id=$1 and owner_id=$2 and name=$3 for share',
        [fixture.teams[alias], id, `${namespace} ${alias}`]
      );
      if (found.rows.length !== 1) throw Error('TEAM');
      owners.set(id, {
        team: fixture.teams[alias],
        email: `${namespace}-${actorAlias.toLowerCase()}@soty.invalid`
      });
    }
    stage = 'scope';
    const pending = (
      await db.query(
        `select notice.id,notice.tariff_id,notice.requested_by,tariff.owner_id,tariff.team_id
       from public.space_tariff_notices notice left join public.space_tariffs tariff on tariff.id=notice.tariff_id
       where notice.state='pending' and notice.attempts<3 order by notice.id limit 101`
      )
    ).rows;
    if (
      pending.length > 100 ||
      pending.some(row => {
        const owner = owners.get(row.owner_id);
        return (
          !owner ||
          (row.team_id !== null && row.team_id !== owner.team) ||
          (row.requested_by !== null && !actorIds.includes(row.requested_by))
        );
      })
    )
      throw Error('FOREIGN_PENDING');
    const eligible = new Map(pending.map(row => [row.id, row]));
    const claimed = new Set();

    const day = (await db.query('select private.kyiv_today()::text as tariff_day')).rows[0]
      .tariff_day;
    stage = 'claim';
    const captureDeadline = Date.now() + 30_000;
    const summary = await runTariffNotices({
      environment: 'beta',
      secret: undefined,
      siteUrl: 'http://127.0.0.1:5175',
      sender: { apiKey: '', from: '' },
      now: () => Date.now(),
      tariffNow: () => Date.parse(`${day}T12:00:00Z`),
      claim: async limit => {
        if (captureTimedOut) throw Error('CAPTURE_TIMEOUT');
        const rows = (
          await db.query('select public.service_claim_tariff_notices($1) value', [limit])
        ).rows[0].value;
        if (!Array.isArray(rows)) throw Error('CLAIM');
        return rows.map(row => {
          const expected = eligible.get(row.id);
          const owner = expected && owners.get(expected.owner_id);
          if (
            !expected ||
            !owner ||
            row.tariffId !== expected.tariff_id ||
            row.teamId !== expected.team_id ||
            row.recipientEmail !== owner.email
          )
            throw Error('SCOPE_CHANGED');
          claimed.add(row.id);
          // Keep semantic dates, kind, locale and updater state; no names, contacts or addresses
          // from application content survive into the actual renderer or capture artifact.
          return {
            ...row,
            recipientEmail: 'synthetic@acceptance.invalid',
            recipientName: 'QA owner',
            teamName: row.teamId ? 'QA workspace' : null,
            planNameUk: 'Тестовий тариф',
            planNameEn: 'Test plan',
            memberName: row.memberName ? 'QA member' : null,
            contact: { telegram: null, email: null }
          };
        });
      },
      finish: async (id, sent, error, skipped) => {
        if (captureTimedOut) throw Error('CAPTURE_TIMEOUT');
        if (!claimed.has(id) || sent) throw Error('FINISH');
        return (
          (
            await db.query('select public.service_finish_tariff_notice($1,false,$2,$3) value', [
              id,
              error,
              skipped
            ])
          ).rows[0].value === true
        );
      },
      send: async () => {
        throw Error('DELIVERY_FORBIDDEN');
      },
      capture: async (id, kind, message) => {
        stage = 'capture';
        if (captureTimedOut) throw Error('CAPTURE_TIMEOUT');
        const remaining = captureDeadline - Date.now();
        if (remaining <= 0) {
          captureTimedOut = true;
          throw Error('CAPTURE_TIMEOUT');
        }
        let timer;
        try {
          // A filesystem promise cannot reliably be cancelled. Stop waiting and never
          // acknowledge it later; an immutable late artifact is reconciled on retry.
          await Promise.race([
            Promise.resolve().then(() => record(id, kind, message)),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => {
                  captureTimedOut = true;
                  captureUnconfirmed++;
                  reject(Error('CAPTURE_TIMEOUT'));
                },
                Math.min(5000, remaining)
              );
            })
          ]);
          captured++;
        } finally {
          clearTimeout(timer);
        }
      }
    });
    if (captureTimedOut) throw Error('CAPTURE_TIMEOUT');
    if (summary.failed || summary.sent || summary.captured !== captured) throw Error('INCOMPLETE');
    stage = 'readback';
    const pendingCount = Number(
      (
        await db.query(
          "select count(*)::int pending from public.space_tariff_notices where state='pending' and attempts<3"
        )
      ).rows[0].pending
    );
    stage = 'commit';
    committing = true;
    await db.query('commit');
    let state = summary.claimed > 0 ? 'captured' : 'idle';
    if (pendingCount > 0) state = 'partial';
    return {
      ok: true,
      state,
      pending: pendingCount,
      summary,
      delivered: false,
      databaseCommitted: true
    };
  } catch (error) {
    connectionError(error);
    await db.query('rollback').catch(connectionError);
    const known = new Set([
      'ACCEPTANCE_FIXTURE_CLEANUP_PENDING',
      'CAPTURE_TIMEOUT',
      'NAMESPACE',
      'BUSY',
      'SOURCE',
      'IDENTITY',
      'SEAM',
      'SEAM_ACL',
      'FOREIGN_OVERLAY',
      'ACTOR',
      'TEAM',
      'FOREIGN_PENDING',
      'CLAIM',
      'SCOPE_CHANGED',
      'FINISH',
      'INCOMPLETE'
    ]);
    const reason = idleDisconnected
      ? 'DATABASE_IDLE_TIMEOUT'
      : error instanceof Error && known.has(error.message)
        ? error.message
        : 'UNEXPECTED';
    return {
      reason,
      ok: false,
      code: committing ? 'ACCEPTANCE_MAIL_CAPTURE_UNCONFIRMED' : 'ACCEPTANCE_MAIL_CAPTURE_REFUSED',
      stage,
      captured,
      captureUnconfirmed,
      delivered: false,
      databaseCommitted: committing ? null : false
    };
  } finally {
    db.off?.('error', connectionError);
  }
}

/** No request flag, delivery credential, linked database or remote target can enable capture. */
export async function captureLocalTariffNotices(target) {
  let db;
  try {
    if (!validateLocalTarget(target).ok) throw Error('TARGET');
    const config = await readFile('supabase/config.toml', 'utf8');
    if (!/^project_id\s*=\s*"acceptance[a-z0-9-]*"\s*$/mu.test(config)) throw Error('PROJECT');
    await verifiedLocalStack(target);
    await assertFixtureProvisionable(target.namespace);
    const fixture = await readPrivateState(target.namespace, 'fixtures.json');
    if (
      !validateFixtureState(fixture, target.namespace).ok ||
      !fixture.teams.W1 ||
      !fixture.teams.W2
    )
      throw Error('FIXTURE');
    db = new pg.Client({ connectionString: target.databaseUrl, connectionTimeoutMillis: 5000 });
    // A server timeout can arrive while filesystem work is pending, with no query
    // listener. Keep the owned connection's error event handled through final close.
    db.on('error', () => undefined);
    await db.connect();
    const result = await captureVerifiedFixtureNotices(
      db,
      target.namespace,
      fixture,
      async (id, kind, message) => {
        await storeNoticeCapture(target.namespace, id, kind, message);
      }
    );
    return result;
  } catch {
    return {
      ok: false,
      code: 'ACCEPTANCE_MAIL_CAPTURE_REFUSED',
      stage: 'target',
      captured: 0,
      delivered: false,
      databaseCommitted: false
    };
  } finally {
    await db?.end().catch(() => undefined);
  }
}
