// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ editDictionary: vi.fn() }));
vi.mock('../apps/web/src/api/launches', () => ({ launchApi: api }));
vi.mock('../apps/web/src/team/launches/analytics', () => ({
  launchMutation: (_c: unknown, _a: unknown, run: () => Promise<unknown>) => run()
}));
import { LaunchDictionaryManager } from '../apps/web/src/team/launches/LaunchDictionaryManager';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const original = { id: 'offer-1', value: 'Original', updatedAt: 'v1' };
it('renames, filters, deletes and restores a choice without changing its identity', async () => {
  const changed = vi.fn();
  function Host() {
    const [items, setItems] = useState([original]);
    return (
      <LaunchDictionaryManager
        teamId="team"
        kind="offers"
        items={items}
        selected=""
        disabled={false}
        onChanged={async () => {
          changed();
          const [, , row, op, value] = api.editDictionary.mock.lastCall!;
          setItems(
            op === 'archive'
              ? []
              : [{ ...row, value: op === 'rename' ? value : row.value, updatedAt: 'v2' }]
          );
        }}
      />
    );
  }
  api.editDictionary.mockImplementation(async (_t, _k, row, op, value) => ({
    ...row,
    value: op === 'rename' ? value : row.value,
    updatedAt: 'v2'
  }));
  render(<Host />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage offers' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Corrected' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await waitFor(() => expect(screen.getByText('Corrected')).toBeTruthy());
  fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
    target: { value: 'absent' }
  });
  expect(screen.queryByText('Corrected')).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
  expect(changed).toHaveBeenCalledTimes(3);
  expect(api.editDictionary.mock.calls.map(x => x[2].id)).toEqual([
    'offer-1',
    'offer-1',
    'offer-1'
  ]);
});
it('requires a replacement before deleting the current draft choice', () => {
  render(
    <LaunchDictionaryManager
      teamId="team"
      kind="offers"
      items={[original]}
      selected={original.id}
      disabled={false}
      onChanged={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Manage offers' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getAllByRole('button', { name: 'Delete' })[1].hasAttribute('disabled')).toBe(true);
  expect(api.editDictionary).not.toHaveBeenCalled();
});
