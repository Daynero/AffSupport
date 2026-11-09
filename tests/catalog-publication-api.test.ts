import { expect, it } from 'vitest';
import {
  parseCatalogPublicationCommand,
  parseCatalogPublicationSnapshot
} from '../packages/shared/src/team/catalog-publication-api';
const id = '77000000-0000-4000-8000-000000000010',
  source = '77000000-0000-4000-8000-000000000011';
const target = { kind: 'source', materialId: source, sourceVersion: 'v1' };
const draft = {
  catalogId: id,
  serverNow: Date.parse('2030-01-01T00:00:00Z'),
  revision: 0,
  mode: 'immediate',
  dueAt: null,
  timeZone: null,
  target,
  job: null,
  active: null
};
it('parses a trusted initial draft without claiming existing metadata proves publication', () => {
  expect(parseCatalogPublicationSnapshot(draft)).toMatchObject({
    revision: 0,
    active: null,
    target
  });
});
it('refuses missing policy/clock/target fields instead of assuming immediate', () => {
  for (const value of [
    { ...draft, mode: undefined },
    { ...draft, serverNow: undefined },
    { ...draft, target: null },
    { ...draft, dueAt: '2030-01-01T00:00:00Z' }
  ])
    expect(parseCatalogPublicationSnapshot(value)).toBeNull();
});
it('requires an explicit publication command and preserves held semantics', () => {
  const raw = {
    requestId: id,
    catalogId: id,
    expectedRevision: 0,
    publication: { mode: 'held' },
    target
  };
  expect(parseCatalogPublicationCommand(raw, draft.serverNow).publication.mode).toBe('held');
  expect(() =>
    parseCatalogPublicationCommand({ ...raw, publication: undefined }, draft.serverNow)
  ).toThrow('INVALID_INPUT');
  expect(() =>
    parseCatalogPublicationCommand({ ...raw, expectedRevision: -1 }, draft.serverNow)
  ).toThrow('INVALID_INPUT');
});
it('validates scheduled commands against trusted time and exact zone/offset', () => {
  const raw = {
    requestId: id,
    catalogId: id,
    expectedRevision: 0,
    publication: {
      mode: 'scheduled',
      localDateTime: '2030-01-01T12:00',
      timeZone: 'UTC',
      resolvedOffset: '+00:00',
      dueAt: '2030-01-01T12:00:00Z'
    },
    target
  };
  expect(parseCatalogPublicationCommand(raw, draft.serverNow).publication.mode).toBe('scheduled');
  expect(() => parseCatalogPublicationCommand(raw, Date.parse('2030-01-02T00:00:00Z'))).toThrow(
    'INVALID_INPUT'
  );
});
