// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc })
}));

import { StorageR2PilotsCard } from '../apps/web/src/pages/admin/StorageR2PilotsCard';

/**
 * 057 T014: the administrator's card of the Soty storage (R2) pilot — who holds the permit,
 * with which space limit, adding by email with a limit, removing, and each RPC failure said.
 */

const PILOT = {
  user_id: '05713000-0000-4000-8000-000000000001',
  email: 'pilot@test.invalid',
  max_space_bytes: '100000000000',
  added_at: '2026-11-28T10:00:00Z',
  removed_at: null
};
const REMOVED = {
  ...PILOT,
  user_id: '05713000-0000-4000-8000-000000000002',
  email: 'former@test.invalid',
  removed_at: '2026-11-28T11:00:00Z'
};

let listed: unknown[] = [];
beforeEach(() => {
  localStorage.setItem('language', 'en');
  listed = [PILOT, REMOVED];
  rpc.mockImplementation((name: string) => {
    if (name === 'admin_list_storage_r2_pilots')
      return Promise.resolve({ data: listed, error: null });
    return Promise.resolve({ data: null, error: null });
  });
});
afterEach(() => {
  cleanup();
  rpc.mockReset();
});

it('lists the active pilots with their space limit, not the removed ones', async () => {
  render(<StorageR2PilotsCard />);
  expect(await screen.findByText('pilot@test.invalid')).toBeTruthy();
  expect(screen.getByText('100 GB')).toBeTruthy();
  expect(screen.queryByText('former@test.invalid')).toBeNull();
  expect(screen.getByText(/on https:\/\/next\./u)).toBeTruthy();
});

it('adds a person by email with the limit in decimal gigabytes', async () => {
  render(<StorageR2PilotsCard />);
  await screen.findByText('pilot@test.invalid');
  fireEvent.change(screen.getByLabelText('Pilot email'), {
    target: { value: ' second@test.invalid ' }
  });
  fireEvent.change(screen.getByLabelText('Space limit, GB'), { target: { value: '250' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add to pilot' }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith('admin_add_storage_r2_pilot', {
      p_email: 'second@test.invalid',
      p_max_bytes: 250_000_000_000
    })
  );
  // The list is read again after a change.
  await waitFor(() =>
    expect(rpc.mock.calls.filter(([name]) => name === 'admin_list_storage_r2_pilots')).toHaveLength(
      2
    )
  );
});

it('will not send a limit outside 1–10 240 GB', async () => {
  render(<StorageR2PilotsCard />);
  await screen.findByText('pilot@test.invalid');
  fireEvent.change(screen.getByLabelText('Pilot email'), { target: { value: 'x@test.invalid' } });
  fireEvent.change(screen.getByLabelText('Space limit, GB'), { target: { value: '0' } });
  expect((screen.getByRole('button', { name: 'Add to pilot' }) as HTMLButtonElement).disabled).toBe(
    true
  );
  fireEvent.change(screen.getByLabelText('Space limit, GB'), { target: { value: '20000' } });
  expect((screen.getByRole('button', { name: 'Add to pilot' }) as HTMLButtonElement).disabled).toBe(
    true
  );
  expect(rpc).not.toHaveBeenCalledWith('admin_add_storage_r2_pilot', expect.anything());
});

it('removes a pilot and says the spaces stay', async () => {
  render(<StorageR2PilotsCard />);
  await screen.findByText('pilot@test.invalid');
  expect(screen.getByText(/keeps the spaces they made/u)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove pilot@test.invalid' }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith('admin_remove_storage_r2_pilot', { p_user_id: PILOT.user_id })
  );
});

it('names an unknown email, a refused limit and any other failure', async () => {
  render(<StorageR2PilotsCard />);
  await screen.findByText('pilot@test.invalid');
  const submit = async (message: string) => {
    rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'admin_list_storage_r2_pilots'
          ? { data: listed, error: null }
          : { data: null, error: { message, code: 'P0001' } }
      )
    );
    fireEvent.change(screen.getByLabelText('Pilot email'), { target: { value: 'x@test.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to pilot' }));
    return screen.findByRole('alert');
  };
  expect((await submit('STORAGE_R2_PILOT_UNKNOWN_EMAIL')).textContent).toContain(
    'no account with this email'
  );
  expect((await submit('INVALID_INPUT')).textContent).toContain('from 1 to');
  expect((await submit('Administrator access required')).textContent).toBe(
    'Could not save. Try again.'
  );
});

it('says so when the list cannot be read, and stays quiet before the database has it', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'timeout', code: '57014' } });
  render(<StorageR2PilotsCard />);
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load the pilot list');
  cleanup();
  rpc.mockResolvedValue({ data: null, error: { message: 'missing', code: 'PGRST202' } });
  render(<StorageR2PilotsCard />);
  expect(await screen.findByText('Nobody is in the pilot.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
