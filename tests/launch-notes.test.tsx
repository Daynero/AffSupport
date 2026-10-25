// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  parseLaunchNotes,
  parseLaunchDraft,
  parseLaunchConfig,
  launchDefaultValues,
  applyLaunchDefaultValues,
  launchNoteLabel,
  type LaunchNote
} from '../packages/shared/src/team/launches';
import { LaunchNotesEditor, LaunchNotesResult } from '../apps/web/src/team/launches/LaunchNotes';
import { launchConfig } from './fixtures/launches';
import { analytics } from '../apps/web/src/analytics/service';
const note: LaunchNote = {
  id: '80000000-0000-4000-8000-000000000001',
  title: 'Audience',
  text: 'First line\nSecond line\tvalue'
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('retains multiline note content across draft and generation parsing, without putting it in profiles', () => {
  const config = launchConfig({ notes: [note] });
  expect(parseLaunchDraft(config)?.notes).toEqual([note]);
  const parsed = parseLaunchConfig(config);
  if (!parsed.ok) throw new Error('fixture');
  expect(parsed.value.notes).toEqual([note]);
  expect(launchDefaultValues(config).notes).toBeUndefined();
  expect(applyLaunchDefaultValues(config, {}).notes).toEqual([note]);
  expect(parseLaunchConfig(launchConfig()).ok).toBe(true);
  const many = Array.from({ length: 100 }, (_, index) => ({
    ...note,
    id: `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  }));
  expect(parseLaunchNotes(many)).toHaveLength(100);
  expect(parseLaunchNotes([{ ...note, text: String.fromCharCode(0) }])).toBeNull();
  expect(parseLaunchNotes([note, note])).toBeNull();
  expect(parseLaunchNotes([{ ...note, text: 1 }])).toBeNull();
  expect(parseLaunchNotes([{ ...note, text: 'a'.repeat(8193) }])).toBeNull();
});
it('adds named cells, edits content, removes one and preserves the other', async () => {
  function Host() {
    const [notes, setNotes] = useState<LaunchNote[]>([]);
    return <LaunchNotesEditor notes={notes} onChange={setNotes} disabled={false} />;
  }
  render(<Host />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Notes' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add note' }));
  await user.type(screen.getByRole('textbox', { name: 'Note 1 title' }), 'Audience');
  await user.type(screen.getByRole('textbox', { name: 'Note 1 text' }), 'First\nSecond');
  await user.click(screen.getByRole('button', { name: 'Add note' }));
  await user.type(screen.getByRole('textbox', { name: 'Note 2 text' }), 'Keep me');
  await user.click(screen.getByRole('button', { name: 'Delete note 1' }));
  expect(screen.getByRole('textbox', { name: 'Note 1 text' })).toHaveProperty('value', 'Keep me');
  expect(screen.queryByDisplayValue('Audience')).toBeNull();
});
it('starts expanded, hides empty notes, copies exact content rather than its title and reports success safely', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: write },
    configurable: true
  });
  const track = vi.spyOn(analytics, 'track');
  render(
    <LaunchNotesResult
      notes={[
        note,
        { ...note, id: '80000000-0000-4000-8000-000000000002', title: 'Empty', text: '  \n ' }
      ]}
      disabled={false}
    />
  );
  const button = screen.getByRole('button', { name: 'Audience' });
  expect(screen.queryByRole('button', { name: 'Empty' })).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(write).toHaveBeenCalledWith(note.text));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'));
  expect(button.className).toContain('success');
  expect(track).toHaveBeenCalledWith(
    'operation_completed',
    expect.objectContaining({ flow_step: 'launch_notes_copy' })
  );
  expect(JSON.stringify(track.mock.calls)).not.toContain(note.text);
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Audience' })).toBeNull());
});
it('uses a text excerpt without a title, and exposes a failed clipboard attempt for retry', async () => {
  const write = vi.fn().mockRejectedValue(new Error('denied'));
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: write },
    configurable: true
  });
  const track = vi.spyOn(analytics, 'track');
  const plain = { ...note, title: ' ', text: 'a'.repeat(60) };
  expect(launchNoteLabel(plain)).toBe('a'.repeat(48) + '…');
  render(<LaunchNotesResult notes={[plain]} disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: launchNoteLabel(plain) }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.queryByRole('status')).toBeNull();
  expect(track).toHaveBeenCalledWith(
    'operation_failed',
    expect.objectContaining({ flow_step: 'launch_notes_copy' })
  );
  expect(screen.getByRole('button', { name: launchNoteLabel(plain) })).toHaveProperty(
    'disabled',
    false
  );
});
it('does not render result notes for a title-only or empty collection and respects locked editing', () => {
  const view = render(<LaunchNotesResult notes={[{ ...note, text: '' }]} disabled={false} />);
  expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull();
  view.rerender(<LaunchNotesEditor notes={[note]} disabled onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  expect(screen.getByRole('textbox', { name: 'Note 1 text' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Add note' })).toHaveProperty('disabled', true);
});
