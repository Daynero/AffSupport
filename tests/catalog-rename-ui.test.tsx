// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CatalogRenameDialog } from '../apps/web/src/team/product-catalog/CatalogRenameDialog.js';
import { CatalogIdentity } from '../apps/web/src/team/catalog-updater/CatalogIdentity.js';
import { LaunchResult } from '../apps/web/src/team/launches/LaunchResult.js';
import { filterCatalogRows } from '../apps/web/src/team/catalog-updater/useCatalogUpdater.js';
import {
  matchingCatalogRenameReceipt,
  catalogRenameApi,
  type CatalogRenameClient
} from '../apps/web/src/api/catalog-rename.js';
import { TeamApiError, type CatalogRegistryRow } from '../apps/web/src/api/team.js';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope.js';
import { WorkspaceMutationJournal } from '../apps/web/src/team/workspace/mutationJournal.js';
import { launchConfig, launchSources } from './fixtures/launches.js';
import {
  launchPreview,
  parseCatalogRenameContext,
  parseCatalogRenameReceipt,
  type CatalogRenameContext,
  type CatalogRenameReceipt,
  type LaunchRevision
} from '../packages/shared/src/team/index.js';

const actor = '73000000-0000-4000-8000-000000000001';
const teamId = '73000000-0000-4000-8000-000000000002';
const materialId = '73000000-0000-4000-8000-000000000003';
const operationId = '73000000-0000-4000-8000-000000000004';
const requestKey = '73000000-0000-4000-8000-000000000005';
const context: CatalogRenameContext = {
  teamId,
  materialId,
  currentName: 'Original catalog',
  materialVersion: '12',
  impactVersion: 'binding-proof',
  boundNames: ['Original catalog'],
  requiresAcknowledgement: true
};
const receipt = (
  key: string,
  state: CatalogRenameReceipt['state'] = 'confirmed'
): CatalogRenameReceipt => ({
  teamId,
  materialId,
  requestKey: key,
  operationId,
  state,
  currentName: state === 'confirmed' ? 'New catalog' : null,
  errorCode: null
});
const client = () =>
  ({
    context: vi.fn().mockResolvedValue(context),
    submit: vi.fn().mockImplementation(async input => receipt(input.requestKey)),
    status: vi.fn().mockImplementation(async input => receipt(input.requestKey, 'pending'))
  }) satisfies CatalogRenameClient;
const props = () => ({
  teamId,
  materialId,
  currentName: context.currentName,
  open: true,
  onClose: vi.fn(),
  onRenamed: vi.fn()
});
beforeEach(() => {
  localStorage.clear();
  setPrivateCacheScope(actor, teamId);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setPrivateCacheScope(null, '');
  localStorage.clear();
});
async function typeName() {
  const input = await screen.findByRole('textbox', { name: 'New name' });
  await waitFor(() => expect(input).toHaveProperty('disabled', false));
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: 'New catalog' } });
}
it('requires explicit acknowledgement of proven bound names; Cancel performs no mutation', async () => {
  const api = client(),
    callbacks = props();
  render(<CatalogRenameDialog {...callbacks} client={api} />);
  expect(screen.getByRole('dialog', { name: 'Rename catalog' })).toBeTruthy();
  await typeName();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  expect(screen.getByRole('note').textContent).toContain('Original catalog');
  expect(api.submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(callbacks.onClose).toHaveBeenCalledOnce();
  expect(api.submit).not.toHaveBeenCalled();
});
it('submits one exact stable proof after OK, delivers the canonical name, and stores no names', async () => {
  const api = client(),
    callbacks = props();
  render(<CatalogRenameDialog {...callbacks} client={api} />);
  await typeName();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await waitFor(() => expect(callbacks.onRenamed).toHaveBeenCalledWith('New catalog'));
  expect(api.submit).toHaveBeenCalledOnce();
  expect(api.submit.mock.calls[0][0]).toEqual(
    expect.objectContaining({
      teamId,
      materialId,
      expectedActorId: actor,
      newName: 'New catalog',
      expectedMaterialVersion: '12',
      impactVersion: 'binding-proof',
      acknowledgeBoundNames: true
    })
  );
  expect(
    new WorkspaceMutationJournal('catalog-rename', actor, teamId, localStorage).list()
  ).toEqual([]);
});
it('renames an unbound catalog without manufacturing a link warning', async () => {
  const api = client(),
    callbacks = props();
  api.context.mockResolvedValue({ ...context, boundNames: [], requiresAcknowledgement: false });
  render(<CatalogRenameDialog {...callbacks} client={api} />);
  await typeName();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  await waitFor(() => expect(callbacks.onRenamed).toHaveBeenCalledWith('New catalog'));
  expect(screen.queryByRole('note')).toBeNull();
  expect(api.submit.mock.calls[0][0].acknowledgeBoundNames).toBe(false);
});
it('restores pending identity on reentry and reads it without submitting another rename', async () => {
  const journal = new WorkspaceMutationJournal('catalog-rename', actor, teamId, localStorage);
  const intent = journal.acquire([materialId]);
  const api = client(),
    callbacks = props();
  api.status.mockImplementation(async input => receipt(input.requestKey));
  render(<CatalogRenameDialog {...callbacks} client={api} />);
  await waitFor(() => expect(callbacks.onRenamed).toHaveBeenCalledWith('New catalog'));
  expect(api.status.mock.calls[0][0]).toMatchObject({
    teamId,
    materialId,
    requestKey: intent.id,
    expectedActorId: actor
  });
  expect(api.submit).not.toHaveBeenCalled();
  expect(journal.list()).toEqual([]);
});
it('keeps an unknown transport outcome fenced until readback confirms the original request', async () => {
  const api = client(),
    callbacks = props();
  api.submit.mockRejectedValue(new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true));
  render(<CatalogRenameDialog {...callbacks} client={api} />);
  await typeName();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await waitFor(() => expect(api.status).toHaveBeenCalled());
  const intents = new WorkspaceMutationJournal(
    'catalog-rename',
    actor,
    teamId,
    localStorage
  ).list();
  expect(intents).toHaveLength(1);
  expect(JSON.stringify(intents)).not.toContain('catalog');
  api.status.mockImplementation(async input => receipt(input.requestKey));
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(callbacks.onRenamed).toHaveBeenCalledWith('New catalog'));
  expect(api.submit).toHaveBeenCalledOnce();
});
it('never delivers a successful response after the private actor changes', async () => {
  let resolve!: (value: CatalogRenameReceipt) => void;
  const api = client(),
    callbacks = props();
  api.submit.mockReturnValue(
    new Promise(done => {
      resolve = done;
    })
  );
  const view = render(<CatalogRenameDialog {...callbacks} client={api} />);
  await typeName();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  const key = api.submit.mock.calls[0][0].requestKey;
  view.unmount();
  setPrivateCacheScope('73000000-0000-4000-8000-000000000099', teamId);
  await act(async () => resolve(receipt(key)));
  expect(callbacks.onRenamed).not.toHaveBeenCalled();
});
it('rejects mismatched identity, incomplete confirmed receipts, and fabricated acknowledgement', () => {
  expect(() =>
    matchingCatalogRenameReceipt(receipt(requestKey), { teamId, materialId: actor, requestKey })
  ).toThrow('INVALID_RESPONSE');
  expect(() =>
    matchingCatalogRenameReceipt(receipt(requestKey), { teamId, materialId, requestKey: actor })
  ).toThrow('INVALID_RESPONSE');
  expect(parseCatalogRenameReceipt({ ...receipt(requestKey), operationId: null })).toBeNull();
  expect(parseCatalogRenameContext({ ...context, boundNames: [] })).toBeNull();
});
it('finds a renamed manager catalog by a historical name and exposes the same canonical identity', async () => {
  const row = {
    catalogId: materialId,
    name: 'New catalog',
    videoName: 'Video 24',
    nameAliases: ['Original catalog']
  } as CatalogRegistryRow;
  expect(filterCatalogRows([row], 'original')).toEqual([row]);
  expect(filterCatalogRows([row], 'new')).toEqual([row]);
  const rename = vi.fn();
  render(
    <CatalogIdentity
      name={row.name}
      parts={[row.name, '']}
      context="Video 24"
      previousNames={row.nameAliases}
      sheetUrl="https://example.invalid/catalog"
      onConfigure={vi.fn()}
      onRename={rename}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'New catalog' }));
  expect(screen.getByText('Previous names: Original catalog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  expect(rename).toHaveBeenCalledOnce();
});
it('copies canonical result names while preserving immutable links and legacy labels read-only', async () => {
  const config = launchConfig();
  const preview = launchPreview(config, launchSources);
  if (!preview.ok) throw new Error('fixture');
  const revision: LaunchRevision = {
    id: requestKey,
    revisionNo: 1,
    kind: 'generated',
    config,
    sources: launchSources,
    baselineRevisionId: null,
    baseline: preview.value,
    overrides: { catalogName: 'Legacy result label' },
    catalog: {
      id: operationId,
      materialId,
      variant: 1,
      name: 'Original catalog',
      currentName: 'New catalog',
      boundNames: ['Original catalog', 'Shared historical name'],
      url: 'https://example.invalid/catalog',
      restitchMaterialId: null
    },
    createdAt: '2026-11-13T10:00:00Z'
  };
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write }
  });
  const change = vi.fn();
  render(
    <LaunchResult
      revision={revision}
      overrides={revision.overrides}
      onChange={change}
      onSave={vi.fn()}
      editable
      disabled={false}
    />
  );
  expect(screen.getByText('Name saved in links: Original catalog')).toBeTruthy();
  expect(screen.getByText('Name saved in links: Shared historical name')).toBeTruthy();
  expect(screen.getByText('Previously saved result label: Legacy result label')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Catalog name' }));
  await waitFor(() => expect(write).toHaveBeenCalledWith('New catalog'));
  expect(change).not.toHaveBeenCalled();
  expect(revision.baseline.advertisingUrl).toBe(preview.value.advertisingUrl);
});

it('releases an authoritatively absent command with honest retry guidance, never a missing-catalog claim', async () => {
  const api = client();
  const journal = new WorkspaceMutationJournal('catalog-rename', actor, teamId, localStorage);
  const intent = journal.acquire([materialId]);
  api.status.mockResolvedValue({
    ...receipt(intent.id, 'failed'),
    operationId: null,
    errorCode: 'NOT_FOUND'
  });
  render(<CatalogRenameDialog {...props()} client={api} />);
  expect((await screen.findByRole('alert')).textContent).toContain('rename did not start');
  expect(api.submit).not.toHaveBeenCalled();
  expect(journal.list()).toEqual([]);
});

it('loads rename only on intent and lets a later authoritative name replace the confirmed local display', async () => {
  const config = launchConfig();
  const preview = launchPreview(config, launchSources);
  if (!preview.ok) throw Error('fixture');
  const revision: LaunchRevision = {
    id: requestKey,
    revisionNo: 1,
    kind: 'generated',
    config,
    sources: launchSources,
    baselineRevisionId: null,
    baseline: preview.value,
    overrides: {},
    catalog: {
      id: operationId,
      materialId,
      variant: 1,
      name: 'Original catalog',
      currentName: 'Original catalog',
      boundNames: [],
      url: 'https://example.invalid/catalog',
      restitchMaterialId: null
    },
    createdAt: '2026-11-13T10:00:00Z'
  };
  const read = vi
    .spyOn(catalogRenameApi, 'context')
    .mockResolvedValue({ ...context, boundNames: [], requiresAcknowledgement: false });
  vi.spyOn(catalogRenameApi, 'submit').mockImplementation(async input => receipt(input.requestKey));
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write }
  });
  const renderResult = (value: LaunchRevision) => (
    <LaunchResult
      teamId={teamId}
      revision={value}
      overrides={{}}
      onChange={vi.fn()}
      onSave={vi.fn()}
      editable
      disabled={false}
    />
  );
  const view = render(renderResult(revision));
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Rename catalog' }));
  await typeName();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Copy Catalog name' }));
  await waitFor(() => expect(write).toHaveBeenLastCalledWith('New catalog'));
  view.rerender(
    renderResult({
      ...revision,
      catalog: { ...revision.catalog!, currentName: 'Original catalog' }
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy Catalog name' }));
  await waitFor(() => expect(write).toHaveBeenLastCalledWith('Original catalog'));
});
