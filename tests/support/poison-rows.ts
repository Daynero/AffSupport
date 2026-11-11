import type { TeamTestDb } from './team-db';

/**
 * Makes chosen rows impossible to write: any insert or update of a row whose
 * `column` holds one of `ids` raises `SETTLE_TEST_POISON`. It stands in for
 * whatever makes one production row fail (an actor that no longer resolves, a
 * constraint, a state nobody foresaw) so a test can prove one such row cannot
 * stop a loop from settling the others. Returns a cure that lifts the poison.
 */
export async function poisonRows(
  db: TeamTestDb,
  table: string,
  column: string,
  ids: string[]
): Promise<() => Promise<void>> {
  await db.root(
    `create table if not exists private.test_poison(tbl text not null, id uuid not null)`
  );
  await db.root(
    `create or replace function private.test_poison_guard() returns trigger language plpgsql as $$
     begin
      if exists(select 1 from private.test_poison p where p.tbl=tg_table_schema||'.'||tg_table_name
        and p.id=(to_jsonb(new)->>tg_argv[0])::uuid) then
       raise exception 'SETTLE_TEST_POISON';
      end if;
      return new;
     end $$`
  );
  const [schema, name] = table.split('.');
  const exists = await db.root<{ n: number }>(
    `select count(*)::integer n from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
     join pg_catalog.pg_namespace s on s.oid=c.relnamespace where s.nspname=$1 and c.relname=$2 and t.tgname='test_poison_guard'`,
    [schema, name]
  );
  if (exists[0]!.n === 0)
    await db.root(
      `create trigger test_poison_guard before insert or update on ${table} for each row execute function private.test_poison_guard('${column}')`
    );
  for (const id of ids)
    await db.root('insert into private.test_poison(tbl,id) values($1,$2)', [table, id]);
  return async () => {
    await db.root('delete from private.test_poison where tbl=$1 and id=any($2::uuid[])', [
      table,
      ids
    ]);
  };
}

export interface SettleFailure {
  attempts: number;
  last_code: string;
  deferred: boolean;
}

/** The record a loop keeps for a row that raised, or undefined. */
export async function settleFailure(
  db: TeamTestDb,
  scope: string,
  row: string
): Promise<SettleFailure | undefined> {
  return (
    await db.root<SettleFailure>(
      'select attempts,last_code,retry_after>clock_timestamp() deferred from private.settle_row_failures where scope=$1 and row_id=$2',
      [scope, row]
    )
  )[0];
}

/** Makes a backed-off row due again, as if its backoff had run out. */
export async function expireBackoff(db: TeamTestDb, scope: string, row: string): Promise<void> {
  await db.root(
    "update private.settle_row_failures set retry_after=clock_timestamp()-interval '1 second' where scope=$1 and row_id=$2",
    [scope, row]
  );
}
