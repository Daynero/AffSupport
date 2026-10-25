/** Real local vendor A -> mini A -> full B acceptance. Synthetic rows only. */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createMiniDbRehearsalRuntime, rehearseMiniDbPlan } from './lib/mini-db-rehearsal.mjs';
import { applyMiniDbPlan, dbValueDigest, readMiniDbSnapshot } from './lib/mini-db-transaction.mjs';
import { atomicRecord } from './lib/release/task-store.mjs';

let phase = 'bootstrap';

function requireProof(condition, code) {
  if (!condition) throw new Error(code);
}
function migration(version, name, sql) {
  return {
    version,
    name,
    sql,
    path: `supabase/migrations/${version}_${name}.sql`,
    sourceDigest: createHash('sha256').update(sql).digest('hex')
  };
}
function git(cwd, args) {
  return new Promise((accept, reject) =>
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Mini DB acceptance',
          GIT_AUTHOR_EMAIL: 'mini-db@localhost',
          GIT_COMMITTER_NAME: 'Mini DB acceptance',
          GIT_COMMITTER_EMAIL: 'mini-db@localhost'
        }
      },
      (error, stdout) => (error ? reject(new Error('DB_SELF_GIT_FAILED')) : accept(stdout.trim()))
    )
  );
}
async function withClient(connectionString, action) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 10_000
  });
  try {
    await client.connect();
    return await action(client);
  } finally {
    await client.end().catch(() => client.connection?.stream?.destroy());
  }
}
function siblingUrl(base, suffix) {
  const url = new URL(base);
  requireProof(
    /^\/soty_mini_db_[a-f0-9]+_baseline$/u.test(url.pathname),
    'DB_SELF_OWNED_URL_REQUIRED'
  );
  url.pathname = url.pathname.replace(/_baseline$/u, `_${suffix}`);
  return url.toString();
}

async function assertRows(connectionString, after) {
  await withClient(connectionString, async client => {
    const columns = after ? 'id,note' : 'id';
    const old = await client.query(`SELECT ${columns} FROM public.mini_widgets ORDER BY id`);
    requireProof(
      old.rows.length === 1 && old.rows[0].id === 1 && (!after || old.rows[0].note === null),
      'DB_SELF_OLD_ROW_CHANGED'
    );
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE authenticated');
      const visible = await client.query(`SELECT ${columns} FROM public.mini_widgets`);
      requireProof(visible.rows.length === 1, 'DB_SELF_AUTHENTICATED_READ_FAILED');
      if (after)
        await client.query("INSERT INTO public.mini_widgets(id,note) VALUES(2,'synthetic')");
    } finally {
      await client.query('ROLLBACK');
    }
    await client.query('BEGIN');
    let denied = false;
    try {
      await client.query('SET LOCAL ROLE anon');
      await client.query('SELECT * FROM public.mini_widgets');
    } catch {
      denied = true;
    } finally {
      await client.query('ROLLBACK');
    }
    requireProof(denied, 'DB_SELF_ANON_WAS_ALLOWED');
  });
}

export async function main() {
  const repository = process.cwd();
  const cliPath =
    process.env.SOTY_MINI_SUPABASE_CLI ??
    resolve(repository, 'release/automation/mini-db-tools/node_modules/.bin/supabase');
  // macOS aliases /var to /private/var. Canonicalize our newly owned directory
  // before the evidence writer checks every parent for unsafe symlinks.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'soty-mini-db-self-')));
  const receiptDirectory = join(cwd, 'private-receipts');
  const baseline = migration(
    '20261024000000',
    'synthetic_baseline',
    `
CREATE TABLE public.mini_widgets(id integer PRIMARY KEY);
CREATE TABLE public.mini_gadgets(id integer PRIMARY KEY);
ALTER TABLE public.mini_widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY mini_authenticated ON public.mini_widgets TO authenticated USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.mini_widgets TO authenticated;
REVOKE ALL ON public.mini_widgets FROM anon;
INSERT INTO public.mini_widgets(id) VALUES(1);
INSERT INTO public.mini_gadgets(id) VALUES(1);
`
  );
  const pending = migration(
    '20261025000000',
    'synthetic_optional_columns',
    'ALTER TABLE public.mini_widgets ADD COLUMN note text;\nALTER TABLE public.mini_gadgets ADD COLUMN note text;\nCREATE INDEX mini_widgets_note_idx ON public.mini_widgets (note);\n'
  );
  let runtime;
  let summary;
  try {
    await mkdir(join(cwd, 'supabase/migrations'), { recursive: true });
    await writeFile(join(cwd, 'supabase/config.toml'), 'project_id = "affsupport037"\n');
    for (const source of [baseline, pending]) await writeFile(join(cwd, source.path), source.sql);
    await git(cwd, ['init', '--quiet']);
    await git(cwd, ['add', 'supabase']);
    await git(cwd, ['commit', '--quiet', '-m', 'Synthetic mini DB acceptance']);
    const sourceSha = await git(cwd, ['rev-parse', 'HEAD']);
    runtime = await createMiniDbRehearsalRuntime({ cwd, cliPath });
    await runtime.push('baseline', [baseline]);
    const before = await runtime.snapshot('baseline');
    await assertRows(runtime.urls.baseline, false);
    const binding = {
      kind: 'local-test',
      bindingId: 'local-mini-db',
      supabaseProject: 'local-mini-db',
      digest: dbValueDigest({ acceptance: 'synthetic-mini-db' })
    };
    const plan = {
      kind: 'mini-db-draft',
      schemaVersion: 1,
      sourceSha,
      agentSha: sourceSha,
      bindingDigest: binding.digest,
      targetId: 'local-mini-db',
      projectRef: 'local-mini-db',
      inventory: [baseline, pending].map(({ version, name, path, sourceDigest }) => ({
        version,
        name,
        path,
        sourceDigest
      })),
      migrations: [pending],
      before
    };
    const lossUrl = siblingUrl(runtime.urls.baseline, 'loss');
    const budgetUrl = siblingUrl(runtime.urls.baseline, 'budget');
    const owned = runtime;
    const originalClone = owned.clone;
    owned.clone = async () => {
      await originalClone();
      const admin = new URL(owned.urls.baseline);
      admin.pathname = '/postgres';
      await withClient(admin.toString(), async client => {
        for (const destination of [lossUrl, budgetUrl]) {
          const name = new URL(destination).pathname.slice(1);
          const template = new URL(owned.urls.baseline).pathname.slice(1);
          await client.query(`CREATE DATABASE ${name} TEMPLATE ${template} OWNER postgres`);
        }
      });
    };
    let lossAdopted = false;
    let deadlineAborted = false;
    const result = await rehearseMiniDbPlan({
      cwd,
      plan,
      binding,
      artifactDirectory: join(cwd, 'evidence'),
      deps: {
        createRuntime: async () => owned,
        applyPlan: async options => {
          phase = 'commit-response-loss';
          let lost = false;
          let ddlCount = 0;
          const clientFactory = config => {
            const client = /** @type {any} */ (new pg.Client(config));
            const query = client.query.bind(client);
            client.query = async input => {
              const text = typeof input === 'string' ? input : input.text;
              if (/^ALTER TABLE public\.mini_/u.test(text.trimStart())) ddlCount += 1;
              const result = await query(input);
              if (text === 'COMMIT' && !lost) {
                lost = true;
                throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST');
              }
              return result;
            };
            return client;
          };
          const journal = receipt =>
            atomicRecord(
              join(receiptDirectory, `${randomBytes(8).toString('hex')}.json`),
              receipt,
              true
            );
          const adopted = await applyMiniDbPlan({
            ...options,
            connectionString: lossUrl,
            clientFactory,
            journal
          });
          requireProof(
            adopted.dbOutcome === 'adopted' && lost && ddlCount === 2,
            'DB_SELF_RESPONSE_LOSS_NOT_ADOPTED_ONCE'
          );
          await assertRows(lossUrl, true);
          lossAdopted = true;
          const blocker = new pg.Client({
            connectionString: budgetUrl,
            connectionTimeoutMillis: 5000
          });
          let budgetDdlCount = 0;
          phase = 'absolute-budget';
          const budgetFactory = config => {
            const client = /** @type {any} */ (new pg.Client(config));
            const query = client.query.bind(client);
            client.query = input => {
              const text = typeof input === 'string' ? input : input.text;
              if (/^ALTER TABLE public\.mini_/u.test(text.trimStart())) budgetDdlCount += 1;
              return query(input);
            };
            return client;
          };
          try {
            await blocker.connect();
            await blocker.query('BEGIN');
            // Catalog deparsers may take ACCESS SHARE locks during the fresh
            // baseline read. A concurrent reader permits that read and blocks
            // only the later ADD COLUMN, after the first DDL has completed.
            await blocker.query('LOCK TABLE public.mini_gadgets IN ACCESS SHARE MODE');
            let failure;
            const started = performance.now();
            try {
              await applyMiniDbPlan({
                ...options,
                connectionString: budgetUrl,
                journal,
                clientFactory: budgetFactory,
                localTestBudgetMs: 2000
              });
            } catch (error) {
              failure = error;
            }
            requireProof(failure instanceof Error, 'DB_SELF_DEADLINE_DID_NOT_FAIL');
            requireProof(
              failure instanceof Error && 'dbOutcome' in failure && failure.dbOutcome === 'aborted',
              'DB_SELF_DEADLINE_ABORT_NOT_CONFIRMED'
            );
            requireProof(
              budgetDdlCount === 2 && performance.now() - started < 7000,
              'DB_SELF_ABSOLUTE_BUDGET_NOT_EXERCISED'
            );
          } finally {
            await blocker.query('ROLLBACK').catch(() => {});
            await blocker.end();
          }
          await withClient(budgetUrl, async client => {
            const current = await readMiniDbSnapshot(client);
            requireProof(
              current.historyDigest === before.historyDigest &&
                current.catalogDigest === before.catalogDigest,
              'DB_SELF_DEADLINE_LEFT_PARTIAL_SCHEMA_OR_LEDGER'
            );
          });
          await assertRows(budgetUrl, false);
          deadlineAborted = true;
          phase = 'mini-apply';
          const applied = await applyMiniDbPlan(options);
          await assertRows(owned.urls.mini, true);
          phase = 'next-full-cli';
          return applied;
        }
      }
    });
    summary = {
      ok: true,
      checks: {
        ...result.evidence.checks,
        syntheticOldNewRows: 'verified',
        authenticatedAllowed: 'verified',
        anonDenied: 'verified',
        commitResponseLossAdoptedOnce: lossAdopted,
        absoluteBudgetAtomicAbort: deadlineAborted
      },
      planDigest: result.plan.planDigest
    };
  } finally {
    if (runtime) await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  }
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(
      JSON.stringify({
        ok: false,
        phase,
        dbOutcome:
          error && typeof error === 'object' && 'dbOutcome' in error ? error.dbOutcome : null,
        sqlState: error && typeof error === 'object' && 'sqlState' in error ? error.sqlState : null,
        error: error instanceof Error ? error.message : 'DB_SELF_FAILED'
      })
    );
    process.exitCode = 1;
  });
}
