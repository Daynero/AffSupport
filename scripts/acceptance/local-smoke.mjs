import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { provisionLocalFixtures } from './fixtures.mjs';
import { readOptionalVariants } from './variants.mjs';
import { fixtureAccountName } from './names.mjs';

/** Development evidence only; deliberately does not award entire manual case PASS. */
export async function runLocalSmoke(target) {
  const { state, actors } = await provisionLocalFixtures(target);
  const variants = await readOptionalVariants(target.namespace);
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  for (const alias of ['A', 'B', 'C', 'X', 'S']) {
    const response = await actors[alias].rpc('list_my_teams', {});
    const expected = alias === 'S' ? [] : [alias === 'X' ? state.teams.W2 : state.teams.W1];
    if (variants?.teams.WLegacy && ['B', 'S'].includes(alias))
      expected.push(variants.teams.WLegacy);
    const ids =
      response.ok && Array.isArray(response.data) ? response.data.map(row => row.id) : null;
    add(
      `visible-team-isolation-${alias}`,
      ids !== null && JSON.stringify(ids.sort()) === JSON.stringify(expected.sort()),
      { status: response.status, visibleCount: ids?.length ?? null }
    );
  }
  for (const alias of ['A', 'B', 'C']) {
    const response = await actors[alias].rpc('list_team_accounts', { p_team: state.teams.W1 });
    add(`authorized-read-${alias}`, response.ok, { status: response.status });
  }
  const outsider = await actors.X.rpc('list_team_accounts', { p_team: state.teams.W1 });
  add('outsider-read-denied', !outsider.ok && outsider.status === 403, {
    status: outsider.status,
    code: outsider.code ?? null
  });
  const unique = randomUUID().slice(0, 8);
  for (const alias of ['A', 'B', 'C', 'X']) {
    const response = await actors[alias].rpc('create_team_account', {
      p_team: state.teams.W1,
      p_name: fixtureAccountName(target.namespace, unique, alias)
    });
    const allowed = ['A', 'B'].includes(alias);
    add(`direct-create-${alias}`, allowed ? response.ok : !response.ok && response.status === 403, {
      status: response.status,
      code: response.code ?? null
    });
  }
  const downgrade = await actors.A.rpc('update_membership', {
    p_team: state.teams.W1,
    p_member: state.actors.B.id,
    p_base_role: 'viewer',
    p_overrides: {}
  });
  add('owner-downgrade-editor', downgrade.ok, { status: downgrade.status });
  try {
    const stale = await actors.B.rpc('create_team_account', {
      p_team: state.teams.W1,
      p_name: fixtureAccountName(target.namespace, unique, 'stale')
    });
    add('stale-editor-jwt-write-denied', !stale.ok && stale.status === 403, {
      status: stale.status,
      code: stale.code ?? null
    });
  } finally {
    const restore = await actors.A.rpc('update_membership', {
      p_team: state.teams.W1,
      p_member: state.actors.B.id,
      p_base_role: 'editor',
      p_overrides: {}
    });
    add('restore-editor', restore.ok, { status: restore.status });
  }
  const after = await actors.A.rpc('list_team_accounts', { p_team: state.teams.W1 });
  const attemptedNames = ['C', 'X', 'stale'].map(alias =>
    fixtureAccountName(target.namespace, unique, alias)
  );
  const deniedRows =
    after.ok && Array.isArray(after.data)
      ? after.data.filter(row => attemptedNames.includes(row.name))
      : null;
  add(
    'denied-writes-have-no-visible-side-effects',
    deniedRows !== null && deniedRows.length === 0,
    { deniedRows: deniedRows?.length ?? null }
  );
  const summary = {
    schemaVersion: 1,
    kind: 'development-actor-smoke',
    campaignId: target.namespace,
    generatedAt: new Date().toISOString(),
    ok: checks.every(check => check.passed),
    checks,
    manualCaseVerdict: 'NOT_A_COMPLETE_MANUAL_CASE'
  };
  const directory = path.resolve('release/acceptance', target.namespace, 'smoke');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${Date.now()}.json`),
    JSON.stringify(summary, null, 2) + '\n',
    { flag: 'wx' }
  );
  return summary;
}
