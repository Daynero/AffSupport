import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { validateLocalTarget } from './target.mjs';
import { verifiedLocalStack, validateFixtureState } from './fixtures.mjs';
import { readPrivateState } from './private-state.mjs';
import { mutateFaultJournal, validateFaultCommand } from './fault-journal.mjs';

const reasons = new Map([
  ['ACCEPTANCE_FAULT_INVALID', 'INVALID_INPUT'],
  ['ACCEPTANCE_FAULT_TARGET_UNSAFE', 'TARGET_UNSAFE'],
  ['ACCEPTANCE_TARGET_UNSAFE', 'TARGET_UNSAFE'],
  ['ACCEPTANCE_BETA_PROFILE_UNSAFE', 'PROFILE_UNSAFE'],
  ['ACCEPTANCE_STACK_MISMATCH', 'STACK_MISMATCH'],
  ['ACCEPTANCE_FAULT_FIXTURE_INVALID', 'FIXTURE_INVALID'],
  ['ACCEPTANCE_PRIVATE_STATE_INVALID', 'PRIVATE_STATE_INVALID'],
  ['ACCEPTANCE_PRIVATE_STATE_UNSAFE', 'PRIVATE_STATE_UNSAFE'],
  ['ACCEPTANCE_FIXTURE_CLEANUP_PENDING', 'CLEANUP_PENDING'],
  ['ACCEPTANCE_FAULT_SCOPE_MISMATCH', 'SCOPE_MISMATCH'],
  ['ACCEPTANCE_FAULT_OPERATION_UNOWNED', 'OPERATION_UNOWNED'],
  ['ACCEPTANCE_FAULT_ALREADY_ACCEPTED', 'ALREADY_ACCEPTED'],
  ['ACCEPTANCE_FAULT_OPERATION_AMBIGUOUS', 'OPERATION_AMBIGUOUS'],
  ['ACCEPTANCE_FAULT_BUSY', 'BUSY'],
  ['ACCEPTANCE_FAULT_FOREIGN_SCHEMA', 'FOREIGN_SCHEMA'],
  ['ACCEPTANCE_FAULT_FOREIGN_STATE', 'FOREIGN_STATE'],
  ['ACCEPTANCE_FAULT_SOURCE_INVALID', 'SOURCE_INVALID'],
  ['ACCEPTANCE_FAULT_IDENTITY_INVALID', 'IDENTITY_INVALID'],
  ['ACCEPTANCE_FAULT_STATE_CHANGED', 'STATE_CHANGED'],
  ['ACCEPTANCE_FAULT_NOT_FOUND', 'NOT_FOUND'],
  ['ACCEPTANCE_FAULT_CONFLICT', 'CONFLICT'],
  ['ACCEPTANCE_FAULT_LIMIT', 'LIMIT'],
  ['ACCEPTANCE_FAULT_CLOCK_INVALID', 'CLOCK_INVALID'],
  ['ACCEPTANCE_FAULT_NOT_ACTIVE', 'NOT_ACTIVE'],
  ['ACCEPTANCE_FAULT_EXPIRED', 'EXPIRED'],
  ['ACCEPTANCE_FAULT_TRANSITION_INVALID', 'TRANSITION_INVALID']
]);

/** Local test-tool entry point. Target identity comes from actual CLI/profile
 * observations; neither the request nor a JSON verified flag grants authority.
 * This controls journal state only: it is not evidence of an injected effect.
 */
export async function changeLocalFaultJournal(target, command) {
  let db;
  let stage = 'input';
  let connectionError = false;
  const onError = () => {
    connectionError = true;
  };
  try {
    if (!validateLocalTarget(target).ok || !validateFaultCommand(command, target.namespace))
      throw Error('ACCEPTANCE_FAULT_INVALID');
    stage = 'project';
    const config = await readFile('supabase/config.toml', 'utf8');
    if (!/^project_id\s*=\s*"acceptance[a-z0-9-]*"\s*$/mu.test(config))
      throw Error('ACCEPTANCE_FAULT_TARGET_UNSAFE');
    stage = 'stack';
    await verifiedLocalStack(target);
    stage = 'fixture';
    const fixture = await readPrivateState(target.namespace, 'fixtures.json');
    if (!validateFixtureState(fixture, target.namespace).ok)
      throw Error('ACCEPTANCE_FAULT_FIXTURE_INVALID');
    stage = 'connect';
    db = new pg.Client({
      connectionString: target.databaseUrl,
      connectionTimeoutMillis: 5000,
      query_timeout: 7000
    });
    db.on('error', onError);
    await db.connect();
    stage = 'journal';
    const result = await mutateFaultJournal(db, target.namespace, fixture, command);
    if (connectionError) throw Error('ACCEPTANCE_FAULT_UNCONFIRMED');
    return { ok: true, ...result, databaseCommitted: true, stage: 'complete' };
  } catch (error) {
    // Never expose SQL text, connection configuration or private fixture content.
    const message = error instanceof Error ? error.message : '';
    const unconfirmed = connectionError || message === 'ACCEPTANCE_FAULT_UNCONFIRMED';
    return {
      ok: false,
      journalOnly: true,
      code: unconfirmed ? 'ACCEPTANCE_FAULT_UNCONFIRMED' : 'ACCEPTANCE_FAULT_REFUSED',
      stage,
      reason: connectionError
        ? 'CONNECTION_LOST'
        : unconfirmed
          ? 'COMMIT_ACK_UNKNOWN'
          : (reasons.get(message) ?? 'UNKNOWN'),
      databaseCommitted: unconfirmed ? null : false
    };
  } finally {
    await db?.end().catch(() => undefined);
    db?.removeListener('error', onError);
  }
}
