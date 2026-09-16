// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MATERIAL_NOTE_MAX, normalizeMaterialMetadataPatch } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { MaterialNoteBlock, MaterialNoteDialog } from '../apps/web/src/team/materials/MaterialNote';
import { resetMaterialNotes } from '../apps/web/src/team/materials/materialNotes';

/**
 * A note on a file (024): shown in the details card, edited in place or from a menu, and kept in
 * Soty only.
 */

const TEAM = '24000000-0000-4000-8000-000000000001';
const FILE = '24000000-0000-4000-8000-000000000003';

function client(initial: string | null) {
  let stored = initial;
  return {
    getMaterialNote: vi.fn(async () => stored),
    setMaterialNote: vi.fn(async (_team: string, _file: string, note: string) => {
      stored = note.trim() === '' ? null : note.trim();
      return stored;
    })
  };
}

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  resetMaterialNotes();
  localStorage.clear();
});

describe('a file’s note', () => {
  it('shows the note in the card with its line breaks, and edits it in place', async () => {
    const notes = client('For the Poland launch\nkeep the hook short');
    render(
      <ToastProvider>
        <MaterialNoteBlock teamId={TEAM} materialId={FILE} canEdit client={notes} />
      </ToastProvider>
    );
    const text = await screen.findByText(/For the Poland launch/);
    expect(text.textContent).toBe('For the Poland launch\nkeep the hook short');

    fireEvent.click(screen.getByRole('button', { name: 'Edit the note' }));
    const field = screen.getByRole('textbox', { name: 'Note' });
    fireEvent.change(field, { target: { value: 'Ran on v31-434' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

    await waitFor(() =>
      expect(notes.setMaterialNote).toHaveBeenCalledWith(TEAM, FILE, 'Ran on v31-434')
    );
    expect(await screen.findByText('Ran on v31-434')).toBeTruthy();
  });

  it('offers to add a note only to someone who may write one', async () => {
    const notes = client(null);
    const { rerender } = render(
      <ToastProvider>
        <MaterialNoteBlock teamId={TEAM} materialId={FILE} canEdit={false} client={notes} />
      </ToastProvider>
    );
    await waitFor(() => expect(notes.getMaterialNote).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();

    rerender(
      <ToastProvider>
        <MaterialNoteBlock teamId={TEAM} materialId={FILE} canEdit client={notes} />
      </ToastProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add a note' }));
    expect(screen.getByRole('textbox', { name: 'Note' })).toBeTruthy();
  });

  it('a save from the dialog shows in the card at once', async () => {
    const notes = client(null);
    render(
      <ToastProvider>
        <MaterialNoteBlock teamId={TEAM} materialId={FILE} canEdit client={notes} />
        <MaterialNoteDialog
          teamId={TEAM}
          materialId={FILE}
          name="IN 40.mp4"
          canEdit
          client={notes}
          onClose={() => undefined}
        />
      </ToastProvider>
    );
    const dialog = await screen.findByRole('dialog', { name: 'Note · IN 40.mp4' });
    const field = await waitFor(() => {
      const found = dialog.querySelector('textarea');
      expect(found).toBeTruthy();
      return found as HTMLTextAreaElement;
    });
    fireEvent.change(field, { target: { value: 'Needs new captions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Needs new captions')).toBeTruthy();
  });

  it('shows a viewer the note without an editor', async () => {
    render(
      <ToastProvider>
        <MaterialNoteDialog
          teamId={TEAM}
          materialId={FILE}
          name="IN 40.mp4"
          canEdit={false}
          client={client('Only for UA')}
          onClose={() => undefined}
        />
      </ToastProvider>
    );
    expect(await screen.findByText('Only for UA')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the note in a metadata patch', () => {
  it('is trimmed, emptied to null, and refused past the limit', () => {
    expect(normalizeMaterialMetadataPatch({ note: '  a\nb  ' })).toEqual({ note: 'a\nb' });
    expect(normalizeMaterialMetadataPatch({ note: '   ' })).toEqual({ note: null });
    expect(normalizeMaterialMetadataPatch({ note: 'x'.repeat(MATERIAL_NOTE_MAX + 1) })).toBeNull();
    expect(normalizeMaterialMetadataPatch({ note: 4 })).toBeNull();
  });
});
