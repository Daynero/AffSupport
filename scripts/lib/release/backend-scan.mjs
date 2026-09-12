import { incompatibleMigrations } from './migration-compat.mjs';

/**
 * Working out what a release has to do to the server, from the repository.
 *
 * The backend plan was always the one part of the release a person wrote by
 * hand: which migrations to apply, which functions to deploy, in what order. A
 * hand-written plan is wrong in exactly two ways, and both of them are quiet.
 * It omits something — a function whose behaviour changed under it, because the
 * change was in `_shared` and nobody thought of it as that function changing —
 * and production then runs last month's code against this month's schema. Or it
 * includes something nobody reviewed, because "apply whatever is pending" swept
 * up a migration that arrived from another branch.
 *
 * So the plan is derived instead: from what the remote history says is missing,
 * and from what actually changed in git since the last release. Everything here
 * is a pure function of those two answers.
 */

const SHARED_PREFIX = 'supabase/functions/_shared/';
const FUNCTIONS_PREFIX = 'supabase/functions/';

/**
 * Which Edge Functions this release must redeploy.
 *
 * A change to `_shared` is a change to every function that imports it, and none
 * of those functions' own files were touched. That is the omission a person
 * makes: the diff looks like one file, and it silently changes ten deployed
 * programs.
 *
 * @param {{changedPaths: readonly string[], functions: readonly string[]}} input
 */
export function functionsNeedingDeploy({ changedPaths, functions }) {
  if (changedPaths.some(entry => entry.startsWith(SHARED_PREFIX))) return [...functions].sort();
  const touched = new Set();
  for (const entry of changedPaths) {
    if (!entry.startsWith(FUNCTIONS_PREFIX)) continue;
    const name = entry.slice(FUNCTIONS_PREFIX.length).split('/')[0];
    if (functions.includes(name)) touched.add(name);
  }
  return [...touched].sort();
}

/**
 * @param {{
 *   targetId: string,
 *   migrations: readonly {id: string, digest: string, sql: string}[],
 *   functions: readonly {name: string, digest: string}[]
 * }} input
 * @typedef {{
 *   id: string,
 *   kind: 'migration'|'function',
 *   digest: string,
 *   targetId: string,
 *   compatibleWithPrevious: boolean,
 *   position: string,
 *   dependencies: string[],
 *   checks: string[],
 *   recovery: string
 * }} BackendChange
 *
 * @returns {{plan: {changes: BackendChange[]}|null, blockers: string[]}}
 */
export function buildBackendPlan({ targetId, migrations, functions }) {
  const blockers = incompatibleMigrations(migrations).map(
    problem =>
      `${problem.id} ${problem.reason}, which the currently released client cannot survive — ` +
      `split it into a compatible change now and the removal in a later release`
  );
  if (blockers.length) return { plan: null, blockers };

  // Schema first, then the functions that may depend on it, stated as real
  // dependencies rather than left to the order of a list.
  const migrationChanges = migrations.map(migration => /** @type {BackendChange} */ ({
    id: migration.id,
    kind: 'migration',
    digest: migration.digest,
    targetId,
    compatibleWithPrevious: true,
    position: 'before-web',
    dependencies: [],
    checks: ['history-present', 'postconditions'],
    recovery: 'reconcile'
  }));

  const functionChanges = functions.map(entry => /** @type {BackendChange} */ ({
    id: entry.name,
    kind: 'function',
    digest: entry.digest,
    targetId,
    compatibleWithPrevious: true,
    position: 'before-web',
    dependencies: migrationChanges.map(change => change.id),
    checks: ['deployed-active'],
    recovery: 'redeploy'
  }));

  return { plan: { changes: [...migrationChanges, ...functionChanges] }, blockers: [] };
}

/**
 * A release that changes nothing on the server must say so explicitly, because
 * "no plan" and "an empty plan" are the same thing to the adapter and very
 * different things to a reader.
 */
/** @param {{changes: BackendChange[]}|null} plan */
export function describePlan(plan) {
  const changes = plan?.changes ?? [];
  if (!changes.length) return 'no server changes';
  const migrations = changes.filter(change => change.kind === 'migration').map(change => change.id);
  const functions = changes.filter(change => change.kind === 'function').map(change => change.id);
  return [
    migrations.length ? `migrations: ${migrations.join(', ')}` : null,
    functions.length ? `functions: ${functions.join(', ')}` : null
  ]
    .filter(Boolean)
    .join('; ');
}
