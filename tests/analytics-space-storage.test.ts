import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getSpaceStorageDiagnosis } from '../scripts/analytics/space-storage';

/**
 * 057 T061: `space-storage` reads the projection `public.analytics_space_storage`
 * (20261226390000) — here a table with its columns and a fixture of answers — and says
 * `unsupported`, never zero, on a database that does not have it.
 */
const LIVE = '05761000-0000-4000-8000-000000000001';
const GONE = '05761000-0000-4000-8000-000000000002';
const AS_OF = '2026-11-28T12:00:00.000Z';

const PROJECTION = `create table public.analytics_space_storage(
  space_state text, team_id uuid, pilot boolean, capacity_bytes bigint, used_bytes bigint, counted_objects bigint,
  shared_bytes bigint, used_by_category jsonb, reserved_bytes bigint, uncertain_reservations bigint, live_objects bigint,
  purges_due bigint, purges_in_flight bigint, purges_failed bigint, oldest_due_at timestamptz, purges_deleted_7d bigint,
  delete_delay_p95_s numeric, delete_delay_max_s numeric, reconciliation_id uuid, reconciliation_state text,
  reconciliation_started_at timestamptz, reconciliation_finished_at timestamptz, reconciliation_listed bigint,
  reconciliation_ledger bigint, orphans_found bigint, orphans_deleted bigint, orphans_waiting bigint, missing_objects bigint,
  foreign_keys bigint, reconciliation_error text, derivative_jobs_pending bigint, derivative_jobs_failed bigint,
  derivative_oldest_pending_at timestamptz, commits_7d bigint, commit_signal_p95_ms numeric,
  removed_queued_at timestamptz, removed_finished_at timestamptz, removed_deleted_objects bigint, removed_error text)`;

let db: AnalyticsTestDb;
beforeEach(async () => {
  db = await createAnalyticsDb();
}, 30000);
afterEach(async () => db?.close());

describe('space-storage', () => {
  it('is unsupported, not zero, before the projection exists', async () => {
    const value = await getSpaceStorageDiagnosis(null, AS_OF);
    expect(value.status).toBe('unsupported');
    expect(value.spaces).toEqual([]);
    expect(value.blind_spots[0]).toMatch(/not even zero/u);
  });

  it('shows the ledger, the purge delay, the reconciliation and a deleted space, with findings', async () => {
    await db.exec(`${PROJECTION};
      insert into public.analytics_space_storage values
       ('live','${LIVE}',true,1000,1200,5,100,'{"materials":"900","catalogs":"300","bogus":"1"}',50,1,5,
        2,0,1,'2026-11-28T11:30:00Z',14,12.5,40.2,'05761000-0000-4000-8000-000000000003','done',
        '2026-11-28T03:23:00Z','2026-11-28T03:24:00Z',9,6,3,1,1,2,0,null,4,0,'2026-11-28T11:00:00Z',20,180,
        null,null,null,null),
       ('deleted','${GONE}',null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,
        null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,
        '2026-11-28T11:59:00Z',null,7,'STORAGE_UNAVAILABLE');`);
    const value = await getSpaceStorageDiagnosis(null, AS_OF);
    expect(value.status).toBe('ok');
    const live = value.spaces.find(space => space.team_id === LIVE)!;
    expect(live.ledger).toEqual({
      capacity_bytes: '1000',
      used_bytes: '1200',
      shared_bytes: '100',
      reserved_bytes: '50',
      counted_objects: 5,
      live_objects: 5,
      uncertain_reservations: 1,
      used_by_category: { materials: '900', catalogs: '300' }
    });
    expect(live.purge).toMatchObject({
      due: 2,
      failed: 1,
      deleted_7d: 14,
      delete_delay_p95_s: 12.5
    });
    expect(live.reconciliation).toMatchObject({
      state: 'done',
      orphans_found: 3,
      orphans_deleted: 1,
      missing: 2
    });
    expect(live.commit_signal).toEqual({ commits_7d: 20, p95_ms: 180 });
    const gone = value.spaces.find(space => space.team_id === GONE)!;
    expect(gone.removal).toEqual({
      queued_at: '2026-11-28T11:59:00.000Z',
      finished_at: null,
      deleted_objects: 7,
      error: 'STORAGE_UNAVAILABLE'
    });
    expect(value.findings).toEqual(
      expect.arrayContaining([
        `${GONE}: deleted space still has bytes in R2 (7 deleted so far, last error STORAGE_UNAVAILABLE)`,
        `${LIVE}: over capacity`,
        `${LIVE}: 1 purge(s) gave up`,
        `${LIVE}: a purge has been due for more than 15 minutes (SC-014)`,
        `${LIVE}: 2 committed object(s) missing from R2`,
        `${LIVE}: orphan(s) past their grace not yet deleted`,
        `${LIVE}: 1 reservation(s) wait for their multipart`
      ])
    );
  });

  it('narrows to one space and answers nothing for an id that is not one', async () => {
    await db.exec(`${PROJECTION};
      insert into public.analytics_space_storage(space_state,team_id,pilot,capacity_bytes,used_bytes,counted_objects,
        shared_bytes,used_by_category,reserved_bytes,uncertain_reservations,live_objects,purges_due,purges_in_flight,
        purges_failed,purges_deleted_7d,derivative_jobs_pending,derivative_jobs_failed,commits_7d)
      values ('live','${LIVE}',true,10,0,0,0,'{}',0,0,0,0,0,0,0,0,0,0);`);
    const one = await getSpaceStorageDiagnosis(LIVE, AS_OF);
    expect(one.spaces.map(space => space.team_id)).toEqual([LIVE]);
    expect(one.spaces[0]!.reconciliation).toBeNull();
    expect(one.findings).toEqual([`${LIVE}: never reconciled`]);
    expect((await getSpaceStorageDiagnosis('not-a-space', AS_OF)).spaces).toEqual([]);
    expect((await getSpaceStorageDiagnosis(GONE, AS_OF)).spaces).toEqual([]);
  });
});
