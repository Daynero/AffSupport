// @vitest-environment jsdom
import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { FolderPicker } from '../apps/web/src/team/catalog/FolderPicker';
import { TeamTextEditor } from '../apps/web/src/team/catalog/TeamTextEditor';
import { UploadConflictDialog } from '../apps/web/src/team/explorer/UploadConflictDialog';
import { ProcessMaterialDialog } from '../apps/web/src/team/processing/ProcessMaterialDialog';
import type { CatalogMaterialItem } from '@video-compressor/shared';

const TEAM_ID = '46000000-0000-4000-8000-000000000001';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The dialogs of the explorer, the catalog manager and processing, on the inventory
 * (070, T064; from 024 T134).
 *
 * Read by role: each says what it is waiting for with a status, chooses with named choices, and
 * draws no control of its own — a raw `<button>`, `<input>`, `<select>` or `<textarea>` brought
 * its own height, focus ring and disabled look, which is why two buttons side by side in these
 * windows did not line up.
 */

/** A control the inventory did not draw (the legacy dialog's own ✕ aside). */
function rawControls(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('button, select, textarea, input')).filter(element => {
    if (element.closest('.ui-button, .ui-checkbox, .ui-radio, .ui-search-field, .ui-segmented'))
      return false;
    if (element.matches('.modal-close')) return false;
    if (element.matches('input[type="file"][hidden]')) return false;
    if (element.closest('.ui-input, .ui-textarea, .ui-input-number, .ui-field')) return false;
    return !element.matches(
      '.ui-button, .ui-input, .ui-textarea, [class*="ui-input"], [class*="ui-breadcrumb"]'
    );
  });
}

function dialog(): HTMLElement {
  const all = screen.getAllByRole('dialog');
  return all[all.length - 1]!;
}

describe('the dialogs on the inventory (070, T064)', () => {
  it('the process dialog chooses a tool by name, with no select', () => {
    render(
      <ToastProvider>
        <ProcessMaterialDialog
          teamId={TEAM_ID}
          material={{ id: 'm1', name: 'clip.mp4', category: 'video' }}
          destinationFolderId="folder-1"
          browseClient={{ listMaterials: vi.fn().mockResolvedValue([]) }}
          agentAvailability="ready"
          toolContracts={{ compressor: 3, transcription: 6, imageEmbedding: 2 }}
          client={{ start: vi.fn() }}
          onStarted={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    const tools = within(dialog()).getByRole('radiogroup', { name: 'Tool' });
    expect(
      within(tools)
        .getAllByRole('radio')
        .map(radio => radio.closest('label')?.querySelector('.ui-radio-label')?.textContent)
    ).toEqual(['Video compressor', 'Transcription', 'Image embedding']);
    expect(dialog().querySelector('select')).toBeNull();
    expect(rawControls(dialog())).toEqual([]);
  });

  it('a single-tool file names its tool instead of asking', () => {
    render(
      <ToastProvider>
        <ProcessMaterialDialog
          teamId={TEAM_ID}
          material={{ id: 'm2', name: 'page.zip', category: 'archive' }}
          destinationFolderId="folder-1"
          browseClient={{ listMaterials: vi.fn().mockResolvedValue([]) }}
          agentAvailability="ready"
          toolContracts={{ landingOptimizer: 2 }}
          client={{ start: vi.fn() }}
          onStarted={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    expect(within(dialog()).queryByRole('radiogroup')).toBeNull();
    expect(within(dialog()).getByText('Landing optimizer')).toBeTruthy();
  });

  it('the upload conflict puts its one primary last', () => {
    render(
      <UploadConflictDialog
        request={{ fileName: 'clip.mp4', existingMaterialId: 'm1', remaining: 2 }}
        onChoose={vi.fn()}
      />
    );
    const actions = dialog().querySelector('.team-dialog-actions')!;
    const buttons = within(actions as HTMLElement).getAllByRole('button');
    expect(buttons.at(-1)?.className).toContain('ui-button--solid');
    expect(buttons.filter(button => button.className.includes('ui-button--solid'))).toHaveLength(1);
    expect(rawControls(dialog())).toEqual([]);
  });

  it('the folder picker says it is loading, then walks folders by button', async () => {
    let answer: (rows: unknown[]) => void = () => undefined;
    render(
      <ToastProvider>
        <FolderPicker
          teamId={TEAM_ID}
          client={{
            listMaterials: vi.fn().mockReturnValue(
              new Promise(resolve => {
                answer = resolve as typeof answer;
              })
            )
          }}
          title="Move to…"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    expect(within(dialog()).getByRole('status')).toBeTruthy();
    answer([{ id: 'f1', teamId: TEAM_ID, kind: 'folder', name: 'Campaign', providerId: 'p1' }]);
    const folder = await within(dialog()).findByRole('button', { name: 'Campaign' });
    expect(folder.className).toContain('ui-button');
    // The way back up is the inventory's breadcrumb, not a row of bare buttons.
    expect(dialog().querySelector('.ui-breadcrumb.team-folder-picker-trail')).not.toBeNull();
    expect(rawControls(dialog())).toEqual([]);
  });

  it('the text editor is a field with its count, and asks before throwing a draft away', async () => {
    const material = {
      id: 'm3',
      teamId: TEAM_ID,
      name: 'notes.txt',
      kind: 'file',
      category: 'document',
      mimeType: 'text/plain',
      fileExtension: 'txt',
      driveVersion: '1'
    } as unknown as CatalogMaterialItem;
    render(
      <ToastProvider>
        <TeamTextEditor
          material={material}
          initialText="hello"
          onSave={vi.fn()}
          onReload={vi.fn()}
          onCreateVersion={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    const field = within(dialog()).getByRole('textbox');
    expect(field.className).toContain('ui-textarea');
    await userEvent.type(field, ' world');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getAllByRole('dialog').length).toBe(2));
    expect(rawControls(dialog())).toEqual([]);
  });
});

/** Source-level: what phase 8 moved stays moved (070, T064, ahead of T065's gate). */
describe('the phase 8 files', () => {
  const ROOT = path.resolve(__dirname, '..');
  const DIRS = ['catalog-updater', 'product-catalog', 'processing', 'library', 'preview'].map(dir =>
    path.join(ROOT, 'apps/web/src/team', dir)
  );
  const files = DIRS.flatMap(dir =>
    readdirSync(dir)
      .filter(name => name.endsWith('.tsx'))
      .map(name => path.join(dir, name))
  );

  it('import nothing from the shim', () => {
    const shim = files.filter(file =>
      /from '(?:\.\.\/)+components\/ui'/u.test(readFileSync(file, 'utf8'))
    );
    expect(shim.map(file => path.relative(ROOT, file))).toEqual([]);
  });

  it('write no raw control, but the catalog icon toggles left on purpose', () => {
    const RAW = /<(button|input|select|textarea)(?=[\s/>])/gu;
    const found = files.flatMap(file => {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
      return [...source.matchAll(RAW)].map(() => path.relative(ROOT, file));
    });
    expect(found).toEqual([
      'apps/web/src/team/catalog-updater/CatalogIconControls.tsx',
      'apps/web/src/team/catalog-updater/CatalogIconControls.tsx'
    ]);
  });
});
