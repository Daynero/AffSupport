// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { CatalogCreatedPublicationStatus } from '../apps/web/src/team/product-catalog/CatalogCreatedPublicationStatus';
import type { CatalogPublicationSnapshot } from '@video-compressor/shared';
const actor = '47000000-0000-4000-8000-000000000001',
  catalog = '47000000-0000-4000-8000-000000000002';
const snapshot: CatalogPublicationSnapshot = {
  catalogId: catalog,
  revision: 1,
  mode: 'scheduled',
  dueAt: '2030-01-01T12:00:00Z',
  timeZone: 'UTC',
  target: { kind: 'source', materialId: actor, sourceVersion: '1' },
  job: { id: actor, state: 'waiting', revision: 1, writerFence: null },
  active: null,
  serverNow: Date.now(),
  providerCas: 'unsupported'
};
beforeEach(() => {
  localStorage.setItem('language', 'en');
  setPrivateCacheScope(actor, 'owner');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('shows source-only scheduled publication separately from the created table', async () => {
  const read = vi.fn().mockResolvedValue(snapshot);
  render(<CatalogCreatedPublicationStatus teamId={actor} catalogId={catalog} read={read} />);
  expect(await screen.findByText(/Video-link publication is scheduled for/)).toBeTruthy();
  expect(screen.getByText(/cannot safely update catalog cells/)).toBeTruthy();
  expect(screen.queryByText('The last video-link publication was verified.')).toBeNull();
});
it('shows the planned time without an obsolete unsupported warning when the narrow writer is enabled', async () => {
  const read = vi.fn().mockResolvedValue({ ...snapshot, writerMode: 'video_columns' });
  render(<CatalogCreatedPublicationStatus teamId={actor} catalogId={catalog} read={read} />);
  expect(await screen.findByText(/Video-link publication is scheduled for/)).toBeTruthy();
  expect(screen.queryByText(/cannot safely update catalog cells/)).toBeNull();
  expect(screen.queryByText('The last video-link publication was verified.')).toBeNull();
});
it('suppresses a previous actor publication read after scope changes', async () => {
  let resolve!: (value: CatalogPublicationSnapshot) => void;
  const read = vi.fn().mockImplementation(
    () =>
      new Promise(r => {
        resolve = r;
      })
  );
  render(<CatalogCreatedPublicationStatus teamId={actor} catalogId={catalog} read={read} />);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  const original = resolve;
  await act(async () => {
    setPrivateCacheScope(catalog, 'viewer');
    original(snapshot);
  });
  expect(screen.queryByText(/Video-link publication is scheduled for/)).toBeNull();
});
it('does not call a past, unverified due time "scheduled"', async () => {
  // Beta 2026-11-09: the result card said "scheduled for 8 Nov 23:18" an hour after that time.
  const read = vi.fn().mockResolvedValue({
    ...snapshot,
    writerMode: 'video_columns',
    dueAt: '2026-11-08T21:18:00Z',
    serverNow: Date.parse('2026-11-08T22:30:00Z'),
    job: { ...snapshot.job!, state: 'unknown' }
  });
  render(<CatalogCreatedPublicationStatus teamId={actor} catalogId={catalog} read={read} />);
  expect(
    await screen.findByText(/has passed, but the write to the table is not confirmed/)
  ).toBeTruthy();
  expect(screen.queryByText(/Video-link publication is scheduled for/)).toBeNull();
});
it('says it waits for the videos when the time has come but the set is still being made', async () => {
  const read = vi.fn().mockResolvedValue({
    ...snapshot,
    writerMode: 'video_columns',
    dueAt: '2026-11-09T07:00:00Z',
    serverNow: Date.parse('2026-11-09T07:03:00Z'),
    targetObservation: { basis: 'indexed', state: 'preparing' },
    job: { ...snapshot.job!, state: 'retry_wait' }
  });
  render(<CatalogCreatedPublicationStatus teamId={actor} catalogId={catalog} read={read} />);
  expect(await screen.findByText(/Waiting for all videos to be ready/)).toBeTruthy();
  expect(screen.queryByText(/not confirmed yet/)).toBeNull();
});
