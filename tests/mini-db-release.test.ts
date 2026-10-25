import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const boundary = vi.hoisted(() => ({
  target: vi.fn(),
  apply: vi.fn(),
  reconcile: vi.fn(),
  loadPlan: vi.fn()
}));

vi.mock('../scripts/lib/mini-db-plan.mjs', async importOriginal => ({
  ...(await importOriginal<typeof import('../scripts/lib/mini-db-plan.mjs')>()),
  readMiniDbTargetSnapshot: boundary.target,
  loadVerifiedMiniDbPlan: boundary.loadPlan
}));

vi.mock('../scripts/lib/mini-db-transaction.mjs', async importOriginal => ({
  ...(await importOriginal<typeof import('../scripts/lib/mini-db-transaction.mjs')>()),
  applyMiniDbPlan: boundary.apply,
  reconcileMiniDbPlan: boundary.reconcile
}));

import {
  createMiniDbContext,
  reconcileMiniDbRelease,
  verifyMiniDbBackendProof
} from '../scripts/lib/mini-db-release.mjs';
import { MINI_DB_DIRECTORY } from '../scripts/lib/mini-db-plan.mjs';
import { dbValueDigest } from '../scripts/lib/mini-db-transaction.mjs';
import { atomicRecord } from '../scripts/lib/release/task-store.mjs';
import {
  acquireWebReleaseLock,
  assertWebReleaseUnlocked,
  webReleaseStateFile
} from '../scripts/lib/web-only-lock.mjs';
import { withLegacyBackendWriter } from '../scripts/lib/mini-db-writer-lock.mjs';

const roots: string[] = [];
const binding = {
  kind: 'local-test',
  bindingId: 'local-mini-db',
  supabaseProject: 'local-mini-db',
  digest: 'a'.repeat(64)
};
const sourceSha = 'b'.repeat(40);
const agentSha = 'c'.repeat(40);
const session = { pid: 5123, backendStart: '2026-10-25T12:00:00.000Z' };
const sql = 'ALTER TABLE public.widgets ADD COLUMN note text;';
const migration = {
  path: 'supabase/migrations/20261025120000_optional_note.sql',
  version: '20261025120000',
  name: 'optional_note',
  sql,
  sourceDigest: createHash('sha256').update(sql).digest('hex')
};

function snapshots() {
  const relation = {
    kind: 'relation',
    schema: 'public',
    name: 'widgets',
    definition: { kind: 'r', accessMethod: 'heap', partition: null, parents: [], children: [] }
  };
  const id = {
    kind: 'column',
    schema: 'public',
    name: 'widgets.id',
    definition: {
      type: 'bigint',
      typeSchema: 'pg_catalog',
      typeKind: 'b',
      nullable: false,
      default: null,
      identity: '',
      generated: '',
      acl: null,
      position: 1,
      collation: null,
      collationSchema: null,
      btreeOpclasses: [{ schema: 'pg_catalog', name: 'int8_ops' }]
    }
  };
  const note = {
    kind: 'column',
    schema: 'public',
    name: 'widgets.note',
    definition: {
      type: 'text',
      typeSchema: 'pg_catalog',
      typeKind: 'b',
      nullable: true,
      default: null,
      identity: '',
      generated: '',
      acl: null,
      position: 2,
      collation: 'default',
      collationSchema: 'pg_catalog',
      btreeOpclasses: [{ schema: 'pg_catalog', name: 'text_ops' }]
    }
  };
  const snapshot = (after: boolean) => {
    const history = after
      ? [{ version: migration.version, name: migration.name, statements: [sql] }]
      : [];
    const catalog = after ? [relation, id, note] : [relation, id];
    const metadata = {
      pgMajor: 17,
      extensions: [],
      eventTriggers: [],
      ledgerDigest: 'd'.repeat(64)
    };
    return {
      ...metadata,
      history,
      catalog,
      historyDigest: dbValueDigest(history),
      catalogDigest: dbValueDigest({ ...metadata, catalog })
    };
  };
  return { before: snapshot(false), after: snapshot(true) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mini-db-release-'));
  roots.push(root);
  const { before, after } = snapshots();
  const draftContent = {
    schemaVersion: 1,
    kind: 'mini-db-draft',
    sourceSha,
    agentSha,
    bindingDigest: binding.digest,
    targetId: binding.bindingId,
    projectRef: binding.supabaseProject,
    backendPaths: [migration.path],
    createdAt: '2026-10-25T12:00:00.000Z',
    inventory: [migration],
    migrations: [migration],
    before
  };
  const draft = { ...draftContent, draftDigest: dbValueDigest(draftContent) };
  const content = { ...draft, after, migrations: [{ ...migration, statements: [sql] }] };
  const plan = { ...content, planDigest: dbValueDigest(content) };
  const evidence = {
    planDigest: plan.planDigest,
    before,
    after,
    checks: { baseline: 'matched', miniVendor: 'matched', nextFullCli: 'verified' }
  };
  const rehearsalDigest = dbValueDigest(evidence);
  await atomicRecord(join(root, 'draft.json'), draft);
  await atomicRecord(
    join(root, MINI_DB_DIRECTORY, 'drafts', `${draft.draftDigest}.verified.json`),
    { schemaVersion: 1, sourceSha, planDigest: plan.planDigest, rehearsalDigest }
  );
  await atomicRecord(
    join(root, MINI_DB_DIRECTORY, 'plans', `${plan.planDigest}.evidence.json`),
    evidence
  );
  boundary.target.mockResolvedValue(before);
  boundary.loadPlan.mockResolvedValue(plan);
  const context = await createMiniDbContext({ cwd: root, documentPath: 'draft.json' });
  await context.prepare({
    binding,
    gate: async () => {
      throw new Error('Unexpected rehearsal gate');
    }
  });
  const betaProof = {
    schemaVersion: 1,
    kind: 'mini-db',
    state: 'prepared',
    sourceSha,
    planDigest: plan.planDigest,
    draftDigest: draft.draftDigest,
    rehearsalDigest,
    backendPaths: draft.backendPaths,
    before: { historyDigest: before.historyDigest, catalogDigest: before.catalogDigest },
    after: { historyDigest: after.historyDigest, catalogDigest: after.catalogDigest },
    betaSchemaVerified: true
  };
  return { root, context, before, after, plan, betaProof };
}

async function pending(root: string) {
  return JSON.parse(
    await readFile(await webReleaseStateFile(root, 'mini-db-pending.json'), 'utf8')
  );
}

function applicationFailure(dbOutcome: 'unknown' | 'aborted') {
  return Object.assign(new Error('DB_APPLY_FAILED'), {
    code: 'DB_APPLY_FAILED',
    dbOutcome,
    session
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    'SOTY_MINI_DATABASE_URL',
    'postgresql://postgres:fixture@127.0.0.1:5432/soty_mini_db_fixture'
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});

describe('mini DB coordinator uncertainty boundary', () => {
  it('refuses a cached prepared proof at the publish boundary even when its beta and rehearsal evidence are valid', async () => {
    const { root, betaProof } = await fixture();
    await expect(
      verifyMiniDbBackendProof({ cwd: root, binding, backend: betaProof, sourceSha })
    ).rejects.toThrow('DB_WEB_PROOF_UNPROVEN');
    expect(boundary.apply).not.toHaveBeenCalled();
  });

  it('requires a verified beta receipt before activation and creates no intent marker on refusal', async () => {
    const { root, context } = await fixture();
    await expect(context.activate()).rejects.toThrow('DB_ACTIVATION_UNPREPARED');
    expect(boundary.apply).not.toHaveBeenCalled();
    await expect(pending(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the canonical prepared marker after transport uncertainty and blocks every writer path', async () => {
    const { root, context, betaProof, plan } = await fixture();
    await context.adoptProof(betaProof);
    boundary.apply.mockImplementation(async ({ journal }) => {
      await journal({
        schemaVersion: 1,
        phase: 'prepared',
        session,
        before: betaProof.before,
        after: betaProof.after
      });
      expect(await pending(root)).toMatchObject({
        kind: 'mini-db',
        session,
        planDigest: plan.planDigest
      });
      throw applicationFailure('unknown');
    });
    const owner = await acquireWebReleaseLock({ root, owner: 'mini-fixture' });
    try {
      await expect(context.activate()).rejects.toMatchObject({ dbOutcome: 'unknown' });
      await expect(assertWebReleaseUnlocked(root, owner.token)).rejects.toThrow(
        'DB_PUBLICATION_UNRESOLVED'
      );
    } finally {
      await owner.release();
    }
    expect((await pending(root)).session).toEqual(session);
    await expect(acquireWebReleaseLock({ root, owner: 'next-mini' })).rejects.toThrow(
      'DB_PUBLICATION_UNRESOLVED'
    );
    await expect(assertWebReleaseUnlocked(root)).rejects.toThrow('DB_PUBLICATION_UNRESOLVED');
    await expect(
      withLegacyBackendWriter(
        {
          root,
          owner: 'legacy',
          sourceSha,
          binding,
          journalPath: join(root, 'legacy.ndjson'),
          runId: 'legacy',
          inheritedToken: null
        },
        async () => ({ ok: true })
      )
    ).rejects.toMatchObject({ code: 'DB_PUBLICATION_UNRESOLVED' });
    expect(boundary.apply).toHaveBeenCalledOnce();
  });

  it('clears a known aborted transaction without retrying SQL or manufacturing a committed state', async () => {
    const { root, context, betaProof } = await fixture();
    await context.adoptProof(betaProof);
    boundary.apply.mockImplementation(async ({ journal }) => {
      await journal({ schemaVersion: 1, phase: 'prepared', session });
      throw applicationFailure('aborted');
    });
    await expect(context.activate()).rejects.toMatchObject({ dbOutcome: 'aborted' });
    await expect(pending(root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(await webReleaseStateFile(root, 'mini-db-state.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(boundary.apply).toHaveBeenCalledOnce();
    const next = await acquireWebReleaseLock({ root, owner: 'after-proven-abort' });
    await next.release();
  });

  it('adopts an already committed backend after later web publication failure without reapplying SQL', async () => {
    const { root, context, betaProof, after } = await fixture();
    await context.adoptProof(betaProof);
    boundary.apply.mockImplementation(async ({ journal }) => {
      await journal({ schemaVersion: 1, phase: 'prepared', session });
      boundary.target.mockResolvedValue(after);
      return { ok: true, dbOutcome: 'committed', snapshot: after, session };
    });
    const publication = async () => {
      await context.activate();
      throw new Error('WEB_UPLOAD_FAILED');
    };
    await expect(publication()).rejects.toThrow('WEB_UPLOAD_FAILED');
    await expect(pending(root)).rejects.toMatchObject({ code: 'ENOENT' });
    const statePath = await webReleaseStateFile(root, 'mini-db-state.json');
    expect(JSON.parse(await readFile(statePath, 'utf8')).dbOutcome).toBe('committed');
    expect((await context.activate()).state).toBe('applied');
    expect(JSON.parse(await readFile(statePath, 'utf8')).dbOutcome).toBe('adopted');
    expect(boundary.apply).toHaveBeenCalledOnce();
  });

  it('reconciles a durable uncertain marker with fresh observation and performs no automatic SQL replay', async () => {
    const { root, context, betaProof, after, plan } = await fixture();
    await context.adoptProof(betaProof);
    boundary.apply.mockImplementation(async ({ journal }) => {
      await journal({ schemaVersion: 1, phase: 'prepared', session });
      throw applicationFailure('unknown');
    });
    await expect(context.activate()).rejects.toMatchObject({ dbOutcome: 'unknown' });
    boundary.reconcile.mockResolvedValue({ dbOutcome: 'committed', snapshot: after, session });
    expect(await reconcileMiniDbRelease({ cwd: root, binding })).toMatchObject({
      ok: true,
      state: 'committed',
      planDigest: plan.planDigest,
      databaseWrites: 0
    });
    expect(boundary.reconcile).toHaveBeenCalledWith(expect.objectContaining({ session, plan }));
    expect(boundary.apply).toHaveBeenCalledOnce();
    await expect(pending(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an unresolved recovery fenced when independent observation is still unknown', async () => {
    const { root, context, betaProof } = await fixture();
    await context.adoptProof(betaProof);
    boundary.apply.mockImplementation(async ({ journal }) => {
      await journal({ schemaVersion: 1, phase: 'prepared', session });
      throw applicationFailure('unknown');
    });
    await expect(context.activate()).rejects.toMatchObject({ dbOutcome: 'unknown' });
    boundary.reconcile.mockResolvedValue({ dbOutcome: 'unknown', session });
    await expect(reconcileMiniDbRelease({ cwd: root, binding })).rejects.toThrow(
      'DB_RECONCILIATION_UNKNOWN'
    );
    expect((await pending(root)).session).toEqual(session);
    expect(boundary.apply).toHaveBeenCalledOnce();
    await expect(acquireWebReleaseLock({ root, owner: 'unsafe-retry' })).rejects.toThrow(
      'DB_PUBLICATION_UNRESOLVED'
    );
  });
});
