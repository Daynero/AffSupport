import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * SQLSTATE 40001 tells PostgREST the transaction lost a race, so it re-runs the
 * transaction itself, without a limit. A function that raises a business answer
 * with it (LEASE_EXPIRED, STALE_RESULT, ...) gives the same answer every time,
 * and the request never returns: on 2026-11-17 one expired library lease held
 * PostgREST connections in that loop and the database sat at 97% CPU.
 *
 * 20261217160000 moved every such raise to PT409 (HTTP 409, no retry). Nothing
 * written after it may bring 40001 back.
 */
const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const CUTOVER = '20261217160000';

describe('migrations after the 40001 cutover', () => {
  it('never raise a business error as a serialization failure', () => {
    const offenders = readdirSync(MIGRATIONS)
      .filter(name => /^\d{14}_.*\.sql$/u.test(name) && name.slice(0, 14) > CUTOVER)
      .filter(name => /errcode\s*=\s*'40001'/iu.test(readFileSync(join(MIGRATIONS, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
