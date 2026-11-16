// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc })
}));

import { ImagePoolPanel } from '../apps/web/src/pages/admin/ImagePoolPanel';

/**
 * 052 pilot (owner 2026-11-16): the owner reviews and refills the shared white image
 * pool and chooses the pilot spaces from the admin page.
 */
const overview = (pilot: Array<{ teamId: string; name: string }> = []) => ({
  policy: {
    state: 'prepared',
    environment: 'production',
    mediaOrigin: 'https://media.example.invalid',
    routingRevision: 'r1',
    acceptedKeyVersions: [1],
    servingVerifiedAt: new Date().toISOString(),
    activatedAt: null
  },
  images: { total: 1, ready: 1, pending: 0, failed: 0, hidden: 0, uses: 7 },
  pilot: pilot.map(team => ({ ...team, addedAt: '2026-11-16T10:00:00Z' })),
  jobs: []
});
const image = {
  id: '00000000-0000-4000-8000-000000000001',
  garment: 'blazer',
  color: 'black',
  state: 'ready',
  active: true,
  uses: 7,
  createdAt: '2026-11-16T10:00:00Z',
  name: 'blazer_black_001.jpg',
  url: 'https://media.example.invalid/g1/00000000-0000-4000-8000-000000000001'
};

beforeEach(() => {
  rpc.mockImplementation((_name: string, args: { p_action: string; p_payload: unknown }) => {
    switch (args.p_action) {
      case 'overview':
        return Promise.resolve({ data: overview(), error: null });
      case 'images':
        return Promise.resolve({ data: { images: [image], total: 1 }, error: null });
      case 'teams':
        return Promise.resolve({
          data: { teams: [{ teamId: 'goor', name: 'Goor' }] },
          error: null
        });
      case 'pilot_add':
        return Promise.resolve({
          data: overview([{ teamId: 'goor', name: 'Goor' }]),
          error: null
        });
      default:
        return Promise.resolve({ data: { active: false }, error: null });
    }
  });
});
afterEach(() => {
  cleanup();
  rpc.mockReset();
});

it('shows the pool, its serving state and its images', async () => {
  render(<ImagePoolPanel />);
  expect(await screen.findByText('Serving works')).toBeTruthy();
  expect(await screen.findByAltText('blazer_black_001.jpg')).toBeTruthy();
  expect(screen.getByText('No pilot spaces')).toBeTruthy();
});

it('adds a space to the pilot by name', async () => {
  render(<ImagePoolPanel />);
  fireEvent.change(await screen.findByLabelText('Find a space by name'), {
    target: { value: 'Goo' }
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Add to pilot' }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith('admin_catalog_global_pool', {
      p_action: 'pilot_add',
      p_payload: { teamId: 'goor' }
    })
  );
  expect(await screen.findByRole('button', { name: 'Remove' })).toBeTruthy();
});

it('hides an image from new catalogs', async () => {
  render(<ImagePoolPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith('admin_catalog_global_pool', {
      p_action: 'hide',
      p_payload: { imageId: image.id }
    })
  );
});
