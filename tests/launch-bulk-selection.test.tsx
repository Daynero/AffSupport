// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LaunchSummary } from '@video-compressor/shared';
import { TeamApiError } from '../apps/web/src/api/team.js';
import {
  useLaunchListSelection,
  launchSelectionRange,
  launchShortcutBlocked
} from '../apps/web/src/team/launches/useLaunchListSelection.js';
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});
it('selects a stable visible range in either direction and handles a removed anchor', () => {
  expect(launchSelectionRange(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c']);
  expect(launchSelectionRange(['a', 'b'], 'gone', 'b')).toEqual(['b']);
});
it('leaves input editing and modal/menu shortcuts to their owners', () => {
  const input = document.createElement('input');
  document.body.append(input);
  expect(launchShortcutBlocked(input)).toBe(true);
  expect(launchShortcutBlocked(document.body)).toBe(false);
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.append(dialog);
  expect(launchShortcutBlocked(document.body)).toBe(true);
});

const seams = vi.hoisted(() => ({
  copy: vi.fn(),
  detail: vi.fn(),
  changed: vi.fn(),
  error: vi.fn(),
  remove: vi.fn()
}));
vi.mock('../apps/web/src/api/team.js', async original => ({
  ...(await original<typeof import('../apps/web/src/api/team.js')>()),
  launchApi: { copy: seams.copy, detail: seams.detail }
}));
const items = ['a', 'b'].map(id => ({ id, version: '1' }) as LaunchSummary);
function Host({ editable = true }: { editable?: boolean }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  useLaunchListSelection({
    teamId: 'team',
    items,
    selected,
    setSelected,
    open: false,
    editable,
    onDelete: seams.remove,
    onChanged: seams.changed,
    onError: seams.error,
    onCopied: () => {}
  });
  return (
    <>
      <output>{[...selected].join(',')}</output>
      <input aria-label="Text" />
    </>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  seams.copy.mockImplementation(async (_team, id) => ({ id: `new-${id}` }));
  seams.detail.mockImplementation(async (_team, id) => ({ id, draft: {} }));
});
it('supports list select, copy and paste while preserving native text editing', async () => {
  render(<Host />);
  fireEvent.keyDown(document.body, { key: 'a', metaKey: true });
  expect(screen.getByRole('status').textContent).toBe('a,b');
  fireEvent.keyDown(document.body, { key: 'c', metaKey: true });
  expect(seams.copy).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'v', metaKey: true });
  expect(seams.copy).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'v', metaKey: true });
  await waitFor(() => expect(seams.copy).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('new-a,new-b'));
  fireEvent.keyDown(document.body, { key: 'Delete' });
  expect(seams.remove).toHaveBeenCalledOnce();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.getByRole('status').textContent).toBe('');
});
it('resumes uncertain paste with the same mutation key and does not duplicate completed siblings', async () => {
  seams.copy.mockRejectedValueOnce(new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true));
  render(<Host />);
  for (const key of ['a', 'c', 'v']) fireEvent.keyDown(document.body, { key, ctrlKey: true });
  await waitFor(() => expect(seams.error).toHaveBeenCalledOnce());
  fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('new-a,new-b'));
  expect(seams.copy).toHaveBeenCalledTimes(3);
  expect(seams.copy.mock.calls[0]).toEqual(seams.copy.mock.calls[1]);
  expect(seams.copy.mock.calls[2][1]).toBe('b');
});
it('stops paste between items when edit permission is lost', async () => {
  let finish!: (value: unknown) => void;
  seams.copy.mockImplementationOnce(
    () =>
      new Promise(r => {
        finish = r;
      })
  );
  const view = render(<Host />);
  for (const key of ['a', 'c', 'v']) fireEvent.keyDown(document.body, { key, ctrlKey: true });
  view.rerender(<Host editable={false} />);
  await act(async () => finish({ id: 'new-a' }));
  expect(seams.copy).toHaveBeenCalledOnce();
});
