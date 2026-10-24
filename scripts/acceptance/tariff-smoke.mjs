import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { provisionLocalFixtures } from './fixtures.mjs';
import { preflightLocal } from './preflight.mjs';
import { fixtureAccountName } from './names.mjs';

/** Exercise the real admin and actor gateways. No domain clock or DB bypass. */
export async function runTariffSmoke(target) {
  const readiness = await preflightLocal(target);
  if (!readiness.ok) throw new Error('ACCEPTANCE_PREFLIGHT_FAILED');
  const { state, actors } = await provisionLocalFixtures(target);
  const checks = [];
  const add = (name, passed, response) =>
    checks.push({ name, passed, status: response?.status ?? null, code: response?.code ?? null });
  const listing = await actors.S.rpc('admin_list_space_tariffs', {});
  const tariff =
    listing.ok && Array.isArray(listing.data)
      ? listing.data.find(row => row.teamId === state.teams.W1 && row.ownerId === state.actors.A.id)
      : null;
  if (!tariff || !['active', 'expiring', 'grace'].includes(tariff.state))
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  for (const alias of ['A', 'B', 'C', 'X']) {
    const denied = await actors[alias].rpc('admin_list_space_tariffs', {});
    add(`admin-list-denied-${alias}`, !denied.ok && denied.status === 403, denied);
  }
  const before = await actors.A.rpc('list_team_accounts', { p_team: state.teams.W1 });
  add('owner-read-before-pause', before.ok, before);
  const history = await actors.S.rpc('admin_list_space_tariff_events', { p_id: tariff.id });
  if (!history.ok || !Array.isArray(history.data))
    throw new Error('ACCEPTANCE_TARIFF_PAUSE_FAILED');
  const existingIds = new Set(history.data.map(row => row.id));
  const suspended = await actors.S.rpc('admin_end_space_tariff', { p_id: tariff.id, p_now: true });
  add('admin-immediate-pause', suspended.ok && suspended.data?.state === 'blocked', suspended);
  const attemptedNames = [];
  let runError;
  let restoreFailed;
  try {
    if (!suspended.ok || suspended.data?.state !== 'blocked')
      throw new Error('ACCEPTANCE_TARIFF_PAUSE_FAILED');
    for (const alias of ['A', 'B', 'C']) {
      const denied = await actors[alias].rpc('list_team_accounts', { p_team: state.teams.W1 });
      add(`paused-read-denied-${alias}`, !denied.ok && denied.status === 403, denied);
      const name = fixtureAccountName(
        target.namespace,
        randomUUID().slice(0, 8),
        `paused-${alias}`
      );
      attemptedNames.push(name);
      const write = await actors[alias].rpc('create_team_account', {
        p_team: state.teams.W1,
        p_name: name
      });
      add(`paused-write-denied-${alias}`, !write.ok && write.status === 403, write);
    }
    const other = await actors.X.rpc('list_team_accounts', { p_team: state.teams.W2 });
    add('other-workspace-still-readable', other.ok, other);
    const staleRole = await actors.B.rpc('update_membership', {
      p_team: state.teams.W1,
      p_member: state.actors.C.id,
      p_base_role: 'editor',
      p_overrides: {}
    });
    add(
      'paused-member-cannot-elevate-viewer',
      !staleRole.ok && staleRole.status === 403,
      staleRole
    );
  } catch (error) {
    runError = error;
  } finally {
    const events = await actors.S.rpc('admin_list_space_tariff_events', { p_id: tariff.id });
    const eventId = findPauseReceipt(events, existingIds, tariff.id, state.actors.S.id);
    if (!eventId) restoreFailed = true;
    else {
      const undo = await actors.S.rpc('admin_undo_space_tariff_event', { p_event: eventId });
      add('admin-undo-pause', undo.ok, undo);
      restoreFailed = !undo.ok;
    }
  }
  if (restoreFailed) throw new Error('ACCEPTANCE_TARIFF_RESTORE_FAILED');
  if (runError) throw runError;
  for (const alias of ['A', 'B', 'C']) {
    const read = await actors[alias].rpc('list_team_accounts', { p_team: state.teams.W1 });
    add(`same-session-read-after-renewal-${alias}`, read.ok, read);
    if (alias === 'A')
      add(
        'paused-writes-have-no-side-effects',
        read.ok &&
          Array.isArray(read.data) &&
          !read.data.some(row => attemptedNames.includes(row.name)),
        read
      );
  }
  for (const alias of ['C', 'X']) {
    const denied = await actors[alias].rpc('create_team_account', {
      p_team: state.teams.W1,
      p_name: fixtureAccountName(target.namespace, randomUUID().slice(0, 8), `renewed-${alias}`)
    });
    add(`renewal-does-not-grant-write-${alias}`, !denied.ok && denied.status === 403, denied);
  }
  const result = {
    schemaVersion: 1,
    campaignId: target.namespace,
    kind: 'development-real-auth-tariff-smoke',
    generatedAt: new Date().toISOString(),
    ok: checks.every(check => check.passed),
    targetFingerprint: readiness.targetFingerprint,
    checks,
    limits: [
      'Immediate admin pause and undo only; calendar grace/DST and background recovery are separate evidence.',
      'No native UI or hosted performance verdict.'
    ]
  };
  const directory = path.resolve('release/acceptance', target.namespace, 'smoke');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `tariff-${Date.now()}.json`),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' }
  );
  return result;
}

/** A mutation reply does not contain eventId; reconcile only this run's unique event. */
export function findPauseReceipt(response, existingIds, tariffId, actorId) {
  if (!response?.ok || !Array.isArray(response.data)) return null;
  const created = response.data.filter(
    row =>
      !existingIds.has(row.id) &&
      row.tariffId === tariffId &&
      row.actorId === actorId &&
      row.kind === 'ended_now' &&
      row.undoable === true
  );
  return created.length === 1 ? created[0].id : null;
}
