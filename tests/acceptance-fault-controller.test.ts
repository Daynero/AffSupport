import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({
  fixture: null as unknown,
  config: 'project_id = "acceptance-controller"',
  guardError: null as Error | null,
  journalError: null as Error | null,
  connects: 0,
  disconnected: false,
  emit: undefined as undefined | (() => void)
}));
vi.mock('node:fs/promises', async original => ({
  ...(await original<Record<string, unknown>>()),
  readFile: async () => io.config
}));
vi.mock('../scripts/acceptance/private-state.mjs', () => ({
  readPrivateState: async () => io.fixture
}));
vi.mock('../scripts/acceptance/fixtures.mjs', async original => ({
  ...(await original<Record<string, unknown>>()),
  verifiedLocalStack: async () => {
    if (io.guardError) throw io.guardError;
    return {};
  }
}));
vi.mock('../scripts/acceptance/fault-journal.mjs', async original => ({
  ...(await original<Record<string, unknown>>()),
  mutateFaultJournal: async () => {
    if (io.journalError) throw io.journalError;
    if (io.disconnected) io.emit?.();
    return { journalOnly: true, state: 'absent', entries: [] };
  }
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      on(_event: string, callback: () => void) {
        io.emit = callback;
      }
      async connect() {
        io.connects++;
      }
      async end() {}
      removeListener() {
        io.emit = undefined;
      }
    }
  }
}));
import { changeLocalFaultJournal } from '../scripts/acceptance/faults.mjs';
const namespace = 'acceptance-controller';
const target = {
  kind: 'local',
  environment: 'beta',
  marker: 'soty-acceptance',
  namespace,
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:private-password@127.0.0.1:54322/postgres'
};
beforeEach(() => {
  io.config = 'project_id = "acceptance-controller"';
  io.guardError = null;
  io.journalError = null;
  io.connects = 0;
  io.disconnected = false;
  io.fixture = {
    namespace,
    actors: Object.fromEntries(
      ['A', 'B', 'C', 'X', 'S'].map(alias => [
        alias,
        {
          id: randomUUID(),
          email: `${namespace}-${alias.toLowerCase()}@soty.invalid`,
          password: 'a'.repeat(32),
          provisioned: true
        }
      ])
    ),
    teams: {}
  };
});
it('explains rejected input before reading the stack or opening a connection', async () => {
  expect(
    await changeLocalFaultJournal({ ...target, kind: 'production' }, { action: 'status' })
  ).toMatchObject({ ok: false, stage: 'input', reason: 'INVALID_INPUT', databaseCommitted: false });
  expect(io.connects).toBe(0);
});
it('reports a project/profile mismatch as a bounded target refusal', async () => {
  io.config = 'project_id = "production"';
  expect(await changeLocalFaultJournal(target, { action: 'status' })).toMatchObject({
    ok: false,
    stage: 'project',
    reason: 'TARGET_UNSAFE'
  });
  expect(io.connects).toBe(0);
});
it.each([
  ['ACCEPTANCE_FAULT_SCOPE_MISMATCH', 'SCOPE_MISMATCH'],
  ['ACCEPTANCE_FAULT_OPERATION_UNOWNED', 'OPERATION_UNOWNED'],
  ['ACCEPTANCE_FAULT_ALREADY_ACCEPTED', 'ALREADY_ACCEPTED'],
  ['ACCEPTANCE_FAULT_OPERATION_AMBIGUOUS', 'OPERATION_AMBIGUOUS'],
  ['ACCEPTANCE_FIXTURE_CLEANUP_PENDING', 'CLEANUP_PENDING'],
  ['ACCEPTANCE_FAULT_FOREIGN_SCHEMA', 'FOREIGN_SCHEMA'],
  ['ACCEPTANCE_FAULT_BUSY', 'BUSY']
])(
  'keeps the closed diagnostic reason for %s without leaking private state',
  async (message, reason) => {
    io.journalError = Error(message);
    const result = await changeLocalFaultJournal(target, { action: 'status' });
    expect(result).toMatchObject({
      ok: false,
      code: 'ACCEPTANCE_FAULT_REFUSED',
      stage: 'journal',
      reason,
      databaseCommitted: false
    });
    expect(JSON.stringify(result)).not.toContain('private-password');
  }
);
it('keeps unknown database messages unknown and redacts their contents', async () => {
  io.journalError = Error('SQL failed /private/path private-password provider-body');
  const result = await changeLocalFaultJournal(target, { action: 'status' });
  expect(result).toMatchObject({ reason: 'UNKNOWN', stage: 'journal' });
  expect(JSON.stringify(result)).not.toMatch(
    /private-password|provider-body|private\/path|SQL failed/u
  );
});
it('reports missing commit acknowledgement as unconfirmed instead of declaring rollback', async () => {
  io.journalError = Error('ACCEPTANCE_FAULT_UNCONFIRMED');
  expect(await changeLocalFaultJournal(target, { action: 'status' })).toMatchObject({
    ok: false,
    code: 'ACCEPTANCE_FAULT_UNCONFIRMED',
    databaseCommitted: null,
    reason: 'COMMIT_ACK_UNKNOWN'
  });
});
it('does not return a success after the owned connection reported a loss', async () => {
  io.disconnected = true;
  expect(await changeLocalFaultJournal(target, { action: 'status' })).toMatchObject({
    ok: false,
    code: 'ACCEPTANCE_FAULT_UNCONFIRMED',
    databaseCommitted: null,
    reason: 'CONNECTION_LOST'
  });
});
