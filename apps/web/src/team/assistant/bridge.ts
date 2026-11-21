/**
 * 064: the assistant lives on the whole space; launches live in «Запуски». This is the narrow way
 * between them: «Запустити N» hands exact rows to the launch section's own batch (053), and a
 * change made by the assistant makes the launch list read again. Nothing else crosses.
 */
import { navigateTo } from '../../lib/navigation';
import { buildTeamRoute, emptyTeamRouteQuery } from '../routes';

export type LaunchRows = Array<{ launchId: string; version: string }>;
type Runner = (rows: LaunchRows, batchKey: string) => Promise<void>;

const runners = new Map<string, Runner>();
const waiting = new Map<string, Array<(runner: Runner) => void>>();
const changed = new Set<(teamId: string) => void>();

/** The launch section registers how it starts a batch while it is mounted. */
export function registerLaunchRunner(teamId: string, runner: Runner): () => void {
  runners.set(teamId, runner);
  for (const resolve of waiting.get(teamId) ?? []) resolve(runner);
  waiting.delete(teamId);
  return () => {
    if (runners.get(teamId) === runner) runners.delete(teamId);
  };
}

export function launchesRoute(teamId: string, launchId: string | null = null): string {
  return buildTeamRoute({
    spaceId: teamId,
    section: 'launches',
    query: { ...emptyTeamRouteQuery(), launchId }
  });
}

/** Starts the batch in «Запуски», opening the section first when it is not on screen. */
export async function launchRows(
  teamId: string,
  rows: LaunchRows,
  batchKey: string
): Promise<void> {
  let runner = runners.get(teamId);
  if (!runner) {
    navigateTo(launchesRoute(teamId), false, false);
    runner = await new Promise<Runner>((resolve, reject) => {
      const list = waiting.get(teamId) ?? [];
      list.push(resolve);
      waiting.set(teamId, list);
      setTimeout(() => reject(new Error('LAUNCHES_NOT_READY')), 15_000);
    });
  }
  await runner(rows, batchKey);
}

export function openLaunch(teamId: string, launchId: string): void {
  navigateTo(launchesRoute(teamId, launchId), false, false);
}

export function onLaunchesChanged(listener: (teamId: string) => void): () => void {
  changed.add(listener);
  return () => changed.delete(listener);
}

export function notifyLaunchesChanged(teamId: string): void {
  for (const listener of changed) listener(teamId);
}
