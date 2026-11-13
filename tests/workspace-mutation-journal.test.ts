// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { WorkspaceMutationJournal } from '../apps/web/src/team/workspace/mutationJournal';
const actor = '47000000-0000-4000-8000-000000000001';
const team = '47000000-0000-4000-8000-000000000002';
const material = '47000000-0000-4000-8000-000000000003';
const second = '47000000-0000-4000-8000-000000000004';
beforeEach(() => localStorage.clear());
it('retains unknown identity over time and refuses overlapping replacement intents', () => {
  const journal = new WorkspaceMutationJournal('bulk-trash', actor, team, localStorage);
  const first = journal.acquire([material, second]);
  first.materialIds.pop();
  const reopened = new WorkspaceMutationJournal('bulk-trash', actor, team, localStorage);
  expect(reopened.acquire([second, material]).materialIds).toEqual([material, second]);
  expect(reopened.acquire([second, material]).id).toBe(first.id);
  expect(() => reopened.acquire([material])).toThrow('PROCESS_RESULT_UNCERTAIN');
  reopened.confirmed(first.id);
  expect(reopened.acquire([material]).id).not.toBe(first.id);
});
it('isolates actors, teams and action identities without deleting another scope', () => {
  const original = new WorkspaceMutationJournal('restore', actor, team, localStorage);
  const first = original.acquire([material]);
  for (const journal of [
    new WorkspaceMutationJournal('bulk-trash', actor, team, localStorage),
    new WorkspaceMutationJournal('restore', second, team, localStorage),
    new WorkspaceMutationJournal('restore', actor, second, localStorage)
  ])
    expect(journal.acquire([material]).id).not.toBe(first.id);
  expect(original.acquire([material]).id).toBe(first.id);
});
it('never lends another draft a pending command identity when a fresh intent is required', () => {
  const firstTab = new WorkspaceMutationJournal(
    'catalog-video-replacement',
    actor,
    team,
    localStorage
  );
  const original = firstTab.acquire([material], { fresh: true });
  const secondTab = new WorkspaceMutationJournal(
    'catalog-video-replacement',
    actor,
    team,
    localStorage
  );
  expect(() => secondTab.acquire([material], { fresh: true })).toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(secondTab.list()).toEqual([original]);
  firstTab.confirmed(original.id);
  expect(secondTab.acquire([material], { fresh: true }).id).not.toBe(original.id);
});
it('refuses malformed persisted identities instead of silently replacing uncertain requests', () => {
  const journal = new WorkspaceMutationJournal('restore', actor, team, localStorage);
  journal.acquire([material]);
  localStorage.setItem(localStorage.key(0)!, '{');
  expect(() => journal.acquire([material])).toThrow('CATALOG_COMMAND_STORAGE_UNAVAILABLE');
});
it('refuses unavailable browser persistence before a caller can issue a write', () => {
  const storage: Storage = {
    get length(): number {
      throw new Error('disabled');
    },
    key: () => null,
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {}
  };
  const journal = new WorkspaceMutationJournal('restore', actor, team, storage);
  expect(() => journal.acquire([material])).toThrow('CATALOG_COMMAND_STORAGE_UNAVAILABLE');
});
