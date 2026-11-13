import { expect, it } from 'vitest';
import {
  parseCatalogRenameContext,
  parseCatalogRenameRequest,
  parseCatalogRenameReceipt
} from '../packages/shared/src/team/catalog-rename';

const id = (n: number) => `cf530000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = {
  teamId: id(1),
  materialId: id(2),
  currentName: 'Каталог · Червень',
  materialVersion: 'material:3',
  impactVersion: 'bindings:7',
  boundNames: ['Original catalog'],
  requiresAcknowledgement: true
};
const request = {
  teamId: id(1),
  materialId: id(2),
  expectedActorId: id(3),
  requestKey: id(4),
  newName: 'Мій каталог · РК 7',
  expectedMaterialVersion: 'material:3',
  impactVersion: 'bindings:7',
  acknowledgeBoundNames: true
};
const receipt = {
  teamId: id(1),
  materialId: id(2),
  requestKey: id(4),
  operationId: id(5),
  state: 'confirmed',
  currentName: request.newName,
  errorCode: null
};

it('preserves Unicode catalog names and frozen versions while stripping unrelated provider fields', () => {
  expect(parseCatalogRenameRequest({ ...request, providerToken: 'discard-me' })).toEqual(request);
  expect(parseCatalogRenameReceipt({ ...receipt, providerPayload: 'discard-me' })).toEqual(receipt);
  const parsed = parseCatalogRenameContext(context);
  expect(parsed).toEqual(context);
  parsed!.boundNames.push('local-only');
  expect(context.boundNames).toEqual(['Original catalog']);
  expect(
    parseCatalogRenameContext({ ...context, boundNames: [], requiresAcknowledgement: false })
  ).not.toBeNull();
  expect(parseCatalogRenameRequest({ ...request, acknowledgeBoundNames: false })).not.toBeNull();
});

it.each([null, [], false, 'catalog'])('rejects a non-object command or receipt: %j', value => {
  expect(parseCatalogRenameContext(value)).toBeNull();
  expect(parseCatalogRenameRequest(value)).toBeNull();
  expect(parseCatalogRenameReceipt(value)).toBeNull();
});

it.each(['', '   ', 'a\nname', 'a\u0000name', '\ud800', 'x'.repeat(1025)])(
  'rejects blank, control-bearing, malformed or oversized names',
  newName => {
    expect(parseCatalogRenameRequest({ ...request, newName })).toBeNull();
    expect(parseCatalogRenameContext({ ...context, currentName: newName })).toBeNull();
    expect(parseCatalogRenameContext({ ...context, boundNames: [newName] })).toBeNull();
    expect(parseCatalogRenameReceipt({ ...receipt, currentName: newName })).toBeNull();
  }
);

it.each(['', 'version\n2', '\ud800', 'v'.repeat(2001), 2])(
  'rejects missing, unbounded or unsafe concurrency versions',
  version => {
    expect(parseCatalogRenameRequest({ ...request, expectedMaterialVersion: version })).toBeNull();
    expect(parseCatalogRenameRequest({ ...request, impactVersion: version })).toBeNull();
    expect(parseCatalogRenameContext({ ...context, materialVersion: version })).toBeNull();
    expect(parseCatalogRenameContext({ ...context, impactVersion: version })).toBeNull();
  }
);

it('accepts bounded names and opaque versions at their limits', () => {
  expect(parseCatalogRenameRequest({ ...request, newName: 'x'.repeat(1024) })).not.toBeNull();
  expect(
    parseCatalogRenameRequest({ ...request, expectedMaterialVersion: 'v'.repeat(2000) })
  ).not.toBeNull();
});

it('requires a coherent immutable-name acknowledgement context', () => {
  for (const patch of [
    { boundNames: [] },
    { boundNames: 'Original catalog' },
    { boundNames: ['Original catalog', 'Original catalog'] },
    { requiresAcknowledgement: false },
    { requiresAcknowledgement: 'true' }
  ]) {
    expect(parseCatalogRenameContext({ ...context, ...patch })).toBeNull();
  }
  expect(parseCatalogRenameRequest({ ...request, acknowledgeBoundNames: 'true' })).toBeNull();
  expect(parseCatalogRenameRequest({ ...request, acknowledgeBoundNames: undefined })).toBeNull();
});

it('rejects missing or malformed actor, material and idempotency identities', () => {
  for (const key of ['teamId', 'materialId', 'expectedActorId', 'requestKey']) {
    expect(parseCatalogRenameRequest({ ...request, [key]: 'not-an-id' })).toBeNull();
  }
  for (const key of ['teamId', 'materialId']) {
    expect(parseCatalogRenameContext({ ...context, [key]: null })).toBeNull();
  }
  for (const key of ['teamId', 'materialId', 'requestKey', 'operationId']) {
    expect(parseCatalogRenameReceipt({ ...receipt, [key]: 'not-an-id' })).toBeNull();
  }
});

it('requires confirmed receipts to carry an operation and name without an error', () => {
  for (const patch of [
    { operationId: null },
    { currentName: null },
    { errorCode: 'DRIVE_UNAVAILABLE' },
    { state: 'complete' },
    { errorCode: 'private provider response' }
  ]) {
    expect(parseCatalogRenameReceipt({ ...receipt, ...patch })).toBeNull();
  }
});

it('keeps pending uncertainty distinct from a proven failed receipt', () => {
  const pending = { ...receipt, state: 'pending', operationId: null, currentName: null };
  expect(parseCatalogRenameReceipt(pending)).toEqual(pending);
  expect(parseCatalogRenameReceipt({ ...pending, state: 'failed' })).toBeNull();
  const failed = { ...pending, state: 'failed', errorCode: 'SOURCE_CHANGED' };
  expect(parseCatalogRenameReceipt(failed)).toEqual(failed);
});
