// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
const m = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  verify: vi.fn(),
  readVerify: vi.fn(),
  change: vi.fn()
}));
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    changeCatalogPublication: m.change,
    readCatalogPublication: m.read,
    saveCatalogPublication: m.save,
    verifyCatalogPublication: m.verify,
    readCatalogPublicationVerification: m.readVerify
  }
}));
import { CatalogPublicationDialog } from '../apps/web/src/team/product-catalog/CatalogPublicationDialog';
const actor = '47000000-0000-4000-8000-000000000001',
  team = '47000000-0000-4000-8000-000000000002',
  catalog = '47000000-0000-4000-8000-000000000003';
const snapshot = {
  catalogId: catalog,
  revision: 0,
  mode: 'immediate',
  dueAt: null,
  timeZone: null,
  target: {
    kind: 'source',
    materialId: '47000000-0000-4000-8000-000000000004',
    sourceVersion: '1'
  },
  job: null,
  active: null,
  serverNow: Date.parse('2026-11-08T00:00:00Z')
};
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  setPrivateCacheScope(actor, 'owner');
  m.read.mockReset().mockResolvedValue(snapshot);
  m.change.mockReset().mockResolvedValue({ ...snapshot, revision: 1 });
  m.verify.mockReset();
  m.readVerify.mockReset().mockResolvedValue(null);
  m.save.mockReset().mockResolvedValue({ ...snapshot, revision: 1, mode: 'held' });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const view = (close = vi.fn()) => ({
  close,
  ...render(
    <CatalogPublicationDialog
      teamId={team}
      catalogId={catalog}
      onClose={close}
      onChanged={() => {}}
    />
  )
});
it('holds an existing publication explicitly without requesting immediate publication', async () => {
  const h = view();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Publication settings saved.')).toBeTruthy();
  expect(h.close).not.toHaveBeenCalled();
  expect(m.save).toHaveBeenCalledWith(
    team,
    expect.objectContaining({
      expectedRevision: 0,
      publication: { mode: 'held' },
      target: snapshot.target
    }),
    expect.any(Object)
  );
});
it('retains a lost save identity across reopen and checks only that original command', async () => {
  m.save.mockRejectedValueOnce(Error('TEAM_TRANSPORT_UNAVAILABLE'));
  const h = view();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(/save result is not confirmed/);
  const command = m.save.mock.calls[0]![1];
  h.unmount();
  m.read.mockResolvedValueOnce(null);
  view();
  await waitFor(() =>
    expect(m.read.mock.calls.at(-1)?.slice(0, 3)).toEqual([team, catalog, command.requestId])
  );
  expect(m.save).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/save result is not confirmed/)).toBeTruthy();
});
it('suppresses old save feedback after the actor changes', async () => {
  let finish!: (value: unknown) => void;
  m.save.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const h = view();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await act(async () => {
    setPrivateCacheScope('47000000-0000-4000-8000-000000000099', 'owner');
    finish({ ...snapshot, revision: 1 });
  });
  expect(h.close).not.toHaveBeenCalled();
});

it('does not strand a definite validation refusal as an unknown mutation', async () => {
  m.save.mockRejectedValueOnce(Object.assign(Error('INVALID_INPUT'), { code: 'INVALID_INPUT' }));
  view();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  await screen.findByRole('alert');
  expect(screen.queryByText(/save result is not confirmed/)).toBeNull();
  expect(
    Object.keys(localStorage).filter(key => key.startsWith('soty:catalog-publication:v1:'))
  ).toEqual([]);
});
// Deferred publication is hidden by the 1.4.2 hotfix (CATALOG_DEFERRED_PUBLICATION_AVAILABLE).
it.skip('shows a dated collapsed summary and expands calendar and timezone without dispatch', async () => {
  view();
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'Schedule the video link' })).toHaveProperty(
      'disabled',
      false
    )
  );
  await userEvent.click(screen.getByRole('switch', { name: 'Schedule the video link' }));
  expect(screen.queryByRole('button', { name: /Time zone/ })).toBeNull();
  const header = screen.getByRole('button', { name: /publication date/i });
  expect(header.textContent).toMatch(/GMT/);
  await userEvent.click(header);
  expect(screen.getByLabelText('Time zone')).toBeTruthy();
  await userEvent.click(header);
  expect(header.textContent).toMatch(/GMT/);
  expect(m.save).not.toHaveBeenCalled();
});

it('recovers a lost baseline-check reply by exact read only after reopening', async () => {
  m.read.mockResolvedValue({
    ...snapshot,
    revision: 1,
    mode: 'scheduled',
    dueAt: '2027-01-01T12:00:00Z',
    timeZone: 'UTC',
    job: {
      id: catalog,
      state: 'blocked',
      revision: 1,
      writerFence: null,
      blockedReason: 'legacy_adoption_required'
    }
  });
  m.verify.mockRejectedValueOnce(Error('PROCESS_RESULT_UNCERTAIN'));
  const h = view();
  await userEvent.click(await screen.findByRole('button', { name: 'Verify existing links' }));
  await screen.findByText(/save result is not confirmed/);
  const request = m.verify.mock.calls[0]![3];
  h.unmount();
  view();
  await waitFor(() =>
    expect(m.readVerify.mock.calls.at(-1)?.slice(0, 3)).toEqual([team, catalog, request])
  );
  expect(m.verify).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/save result is not confirmed/)).toBeTruthy();
});

it('requests add-now explicitly without presenting its acknowledgement as publication', async () => {
  view();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Request publication now' })).toHaveProperty(
      'disabled',
      false
    )
  );
  await userEvent.click(screen.getByRole('button', { name: 'Request publication now' }));
  expect(await screen.findByText('Publication settings saved.')).toBeTruthy();
  expect(m.change).toHaveBeenCalledWith(
    team,
    expect.objectContaining({
      catalogId: catalog,
      expectedRevision: 0,
      action: 'add_now',
      requestId: expect.any(String)
    }),
    expect.any(Object)
  );
  expect(m.save).not.toHaveBeenCalled();
});
