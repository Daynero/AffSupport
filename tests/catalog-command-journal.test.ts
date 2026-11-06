// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { CatalogCommandJournal } from '../apps/web/src/team/catalog-updater/catalogCommandJournal';
const id = (n: number) => `47000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intent = { commandId: id(3), catalogIds: [id(4)], createdAt: 1 };
afterEach(() => localStorage.clear());
it('stores only bounded identifiers, isolates actors, and preserves another tab records', () => {
  const journal = new CatalogCommandJournal(id(1), id(2), localStorage);
  journal.put({ ...intent, name: 'private filename.mp4' } as typeof intent);
  journal.put(intent);
  expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('private');
  expect(journal.list()).toEqual([intent]);
  expect(new CatalogCommandJournal(id(8), id(2), localStorage).list()).toEqual([]);
  new CatalogCommandJournal(id(1), id(2), localStorage).put({ ...intent, commandId: id(6) });
  expect(journal.list()).toHaveLength(2);
  expect(() => journal.put({ ...intent, catalogIds: [id(5)] })).toThrow();
});
it('bounds unresolved work without expiring possibly accepted commands', () => {
  const journal = new CatalogCommandJournal(id(1), id(2), localStorage);
  for (let n = 10; n < 60; n++) journal.put({ ...intent, commandId: id(n) });
  expect(journal.list()).toHaveLength(50);
  expect(() => journal.put(intent)).toThrow();
  journal.remove(id(10));
  journal.put(intent);
  expect(journal.list().find(value => value.commandId === intent.commandId)).toEqual(intent);
});
it.each(['{}', '{', 'x'.repeat(25001)])(
  'refuses corrupted storage instead of forgetting unknown commands',
  raw => {
    localStorage.setItem(`soty.catalog-command.v1:${id(1)}:${id(2)}:${id(3)}`, raw);
    expect(() => new CatalogCommandJournal(id(1), id(2), localStorage).list()).toThrow();
  }
);
