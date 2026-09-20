// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { teamApi } from '../apps/web/src/api/team';
import { PaletteHost } from '../apps/web/src/team/palette/PaletteHost';
import { ShortcutSheet } from '../apps/web/src/team/palette/ShortcutSheet';
import {
  WORKSPACE_SHORTCUTS,
  formatShortcut,
  shortcutKeys,
  matches
} from '../apps/web/src/team/palette/shortcuts';
import { translationKeys } from '../apps/web/src/i18n';
import { isCatalogSheet, rankByName } from '../apps/web/src/team/palette/usePaletteResults';

/**
 * T105 — the palette reaches every kind of thing, and the sheet cannot lie.
 *
 * The workspace had four search fields and none of them reached past the
 * screen it was on: finding a task by name meant going to Tasks first, and the
 * thing you were looking for was usually the reason you wanted to go there.
 *
 * And it answered ten keystrokes while naming none of them — which makes a
 * shortcut something you either already knew or never found. The sheet reads
 * the table the bindings read, so the two cannot drift apart; these hold that.
 */

const TEAM_ID = '26000000-0000-4000-8000-000000000010';

beforeEach(() => {
  localStorage.setItem('language', 'en');
  vi.spyOn(teamApi, 'listFolderTree').mockResolvedValue([
    { id: 'f1', driveFileId: 'drive-f1', name: 'Creatives', parentFolderId: null } as never
  ]);
  vi.spyOn(teamApi, 'listTasks').mockResolvedValue([
    { id: 't1', title: 'Creative for TR', note: null } as never
  ]);
  vi.spyOn(teamApi, 'listAccounts').mockResolvedValue([
    { id: 'a1', name: 'Creative Team' } as never
  ]);
  vi.spyOn(teamApi, 'searchCatalog').mockResolvedValue({
    items: [
      {
        id: 'm1',
        teamId: TEAM_ID,
        name: 'creative.mp4',
        parentFolderId: 'drive-f1',
        kind: 'file',
        category: 'video'
      }
    ],
    total: 1
  } as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function palette() {
  return render(
    <ToastProvider>
      <PaletteHost teamId={TEAM_ID} onClose={vi.fn()} onShortcuts={vi.fn()} />
    </ToastProvider>
  );
}

describe('the workspace palette', () => {
  it('says which folder a file is in, and offers what was opened lately on an empty field', async () => {
    const user = userEvent.setup();
    const { unmount } = palette();
    await user.type(screen.getByRole('combobox'), 'creative');
    // The folder tells same-named files apart (024).
    const file = await screen.findByRole('option', { name: /creative\.mp4/ });
    expect(file.textContent).toContain('Creatives');
    await user.click(file);
    unmount();

    palette();
    expect(await screen.findByText('Recent')).toBeTruthy();
    expect(screen.getByRole('option', { name: /creative\.mp4/ })).toBeTruthy();
  });

  it('reaches a file, a folder, a task and an account from one field', async () => {
    const user = userEvent.setup();
    palette();
    await user.type(screen.getByRole('combobox'), 'creative');

    const list = screen.getByRole('listbox');
    await waitFor(() =>
      expect(within(list).getByRole('option', { name: /creative\.mp4/ })).toBeTruthy()
    );
    expect(within(list).getByRole('option', { name: /^Creatives$/ })).toBeTruthy();
    expect(within(list).getByRole('option', { name: /Creative for TR/ })).toBeTruthy();
    expect(within(list).getByRole('option', { name: /Creative Team/ })).toBeTruthy();

    // Grouped, and named — four kinds of thing in one list is only readable if
    // the list says which is which.
    for (const heading of ['Files', 'Folders', 'Tasks', 'Accounts']) {
      expect(within(list).getByText(heading)).toBeTruthy();
    }
  });

  it('never empties the list while a search is in flight', async () => {
    const user = userEvent.setup();
    palette();
    await user.type(screen.getByRole('combobox'), 'creative');
    await waitFor(() => expect(screen.getByRole('option', { name: /^Creatives$/ })).toBeTruthy());

    // A second keystroke: what is on screen stays on screen. A list that
    // empties itself while you type is a list that makes you stop typing.
    await user.type(screen.getByRole('combobox'), ' ');
    expect(screen.getByRole('option', { name: /^Creatives$/ })).toBeTruthy();
  });

  it('walks the whole list with the arrows, across the group boundaries', async () => {
    const user = userEvent.setup();
    palette();
    await user.type(screen.getByRole('combobox'), 'creative');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(2));

    const options = screen.getAllByRole('option');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    // Up from the top wraps to the end: a list that stops at its edges makes
    // you count how far you have come.
    await user.keyboard('{ArrowUp}{ArrowUp}');
    const last = screen.getAllByRole('option').at(-1)!;
    expect(last.getAttribute('aria-selected')).toBe('true');
  });

  it('puts the closest name first', () => {
    const names = ['Db3_2_compressed_2.mp4', 'old Db3_2 copy.mp4', 'Db3_2.mp4', 'Db3_2_v1_catalog'];
    expect(rankByName(names, 'db3_2', name => name)).toEqual([
      'Db3_2.mp4',
      'Db3_2_v1_catalog',
      'Db3_2_compressed_2.mp4',
      'old Db3_2 copy.mp4'
    ]);
  });

  it('tells a catalog sheet from any other spreadsheet', () => {
    const sheet = 'application/vnd.google-apps.spreadsheet';
    expect(isCatalogSheet('IN 40_v2_catalog', sheet)).toBe(true);
    expect(isCatalogSheet('clip catalog (2)', sheet)).toBe(true);
    expect(isCatalogSheet('Budget', sheet)).toBe(false);
    expect(isCatalogSheet('IN 40_v2_catalog', 'text/plain')).toBe(false);
  });

  it('says what to do before anything is typed', () => {
    palette();
    expect(screen.getByText('Type to search the space')).toBeTruthy();
  });
});

describe('the shortcut sheet', () => {
  it('lists every binding the registry holds, and nothing else', () => {
    render(
      <ToastProvider>
        <ShortcutSheet onClose={vi.fn()} />
      </ToastProvider>
    );
    const terms = screen.getAllByRole('term').map(node => node.textContent);
    expect(terms).toHaveLength(WORKSPACE_SHORTCUTS.length);
    // One keycap per key (024): each row's caps, read together, are the chord.
    const rows = Array.from(document.querySelectorAll('.workspace-shortcuts dl > div'));
    const drawn = rows.map(row =>
      Array.from(row.querySelectorAll('kbd'))
        .map(cap => cap.textContent)
        .join('')
    );
    for (const shortcut of WORKSPACE_SHORTCUTS) {
      expect(drawn).toContain(shortcutKeys(shortcut.keys).join(''));
    }
  });

  it('draws a chord as one cap per key', () => {
    expect(shortcutKeys('mod+k', true)).toEqual(['⌘', 'K']);
    expect(shortcutKeys('mod+k', false)).toEqual(['Ctrl', 'K']);
    expect(shortcutKeys('escape', true)).toEqual(['Esc']);
    expect(shortcutKeys('arrows', true)).toEqual(['↑', '↓', '←', '→']);
  });

  it('has a sentence for every shortcut, in both languages', () => {
    const keys = new Set(translationKeys);
    for (const shortcut of WORKSPACE_SHORTCUTS) {
      expect(keys.has(shortcut.labelKey), shortcut.id).toBe(true);
    }
  });

  it('writes a chord the way the reader’s own keyboard spells it', () => {
    expect(formatShortcut('mod+k', true)).toBe('⌘K');
    expect(formatShortcut('mod+k', false)).toBe('Ctrl+K');
    expect(formatShortcut('enter', true)).toBe('↵');
  });

  it('matches only the chord it names', () => {
    const event = (init: Partial<KeyboardEvent>) => ({ ...init }) as KeyboardEvent;
    expect(matches(event({ key: 'k', metaKey: true }), 'mod+k')).toBe(true);
    expect(matches(event({ key: 'k' }), 'mod+k')).toBe(false);
    // Shift is part of a chord or it is not; a binding that fires with extra
    // modifiers held is a binding that fires when you meant something else.
    expect(matches(event({ key: 'k', metaKey: true, shiftKey: true }), 'mod+k')).toBe(false);
  });
});

describe('a folder path', () => {
  it('names the folders top down, and the root by its label', async () => {
    const { folderPathLabel, indexFolders } =
      await import('../apps/web/src/team/explorer/folderPath');
    const folders = indexFolders([
      { driveFileId: 'a', parentFolderId: null, name: 'Creo' },
      { driveFileId: 'b', parentFolderId: 'a', name: 'GlucoSoft' }
    ]);
    expect(folderPathLabel('b', folders, 'All files')).toBe('Creo / GlucoSoft');
    expect(folderPathLabel(null, folders, 'All files')).toBe('All files');
  });
});
