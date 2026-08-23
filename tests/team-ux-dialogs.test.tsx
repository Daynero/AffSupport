// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamTextEditor } from '../apps/web/src/team/catalog/TeamTextEditor';
import { FolderPicker } from '../apps/web/src/team/catalog/FolderPicker';
import type { CatalogMaterialItem } from '@video-compressor/shared';

/**
 * US6 — one dialog behaviour everywhere.
 *
 * Seven team surfaces used to be hand-rolled `position: fixed` blocks with no
 * portal, focus trap, Escape or backdrop, on a z-index band *below* the real
 * dialogs — so they stacked into dead layers and a preview could render
 * underneath a modal (finding C1). They are all `Modal` children now, and these
 * assertions are what keeps the next one from being hand-rolled again.
 */

const TEAM_ID = '20000000-0000-4000-8000-000000000001';
const css = readFileSync(resolve('apps/web/src/styles.css'), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
});

function material(): CatalogMaterialItem {
  return {
    id: 'material-1',
    teamId: TEAM_ID,
    name: 'copy.txt',
    kind: 'file',
    category: 'transcript',
    mimeType: 'text/plain',
    fileExtension: 'txt',
    classificationVersion: 1,
    classificationSource: 'mime',
    sizeBytes: 12,
    modifiedAt: null,
    geo: null,
    language: null,
    offer: null,
    tags: [],
    transcriptIngestState: 'full',
    transcriptTruncated: false,
    previewState: 'ready',
    lineage: { hasSource: false, hasDerivatives: false, isVersion: false }
  };
}

/** Lets the dialog's opening focus frame run before the test interacts. */
async function opened() {
  await act(async () => {
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
  });
}

describe('every team dialog behaves like a dialog', () => {
  it('closes an untouched editor on Escape', async () => {
    const onClose = vi.fn();
    render(
      <ToastProvider>
        <TeamTextEditor
          material={material()}
          initialText="hello"
          expectedDriveVersion="7"
          onSave={vi.fn()}
          onReload={vi.fn()}
          onCreateVersion={vi.fn()}
          onClose={onClose}
        />
      </ToastProvider>
    );
    await opened();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('asks before throwing away edits, rather than closing on the keypress', async () => {
    const onClose = vi.fn();
    render(
      <ToastProvider>
        <TeamTextEditor
          material={material()}
          initialText="hello"
          expectedDriveVersion="7"
          onSave={vi.fn()}
          onReload={vi.fn()}
          onCreateVersion={vi.fn()}
          onClose={onClose}
        />
      </ToastProvider>
    );
    await opened();
    await userEvent.type(screen.getByRole('textbox', { name: 'Text file contents' }), '!');

    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText('Discard your edits?')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders through a portal and locks the page behind it', async () => {
    const { container } = render(
      <ToastProvider>
        <FolderPicker
          teamId={TEAM_ID}
          client={{ listMaterials: vi.fn().mockResolvedValue([]) }}
          title="Move to…"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    await opened();

    // Not inside the caller's tree: a hand-rolled overlay stayed in place and
    // let the page scroll behind it.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() => expect(document.body.querySelector('.modal-backdrop')).not.toBeNull());
  });

  it('marks itself modal and points at its own title', async () => {
    render(
      <ToastProvider>
        <FolderPicker
          teamId={TEAM_ID}
          client={{ listMaterials: vi.fn().mockResolvedValue([]) }}
          title="Move to…"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Move to…');
  });
});

describe('the layer ladder', () => {
  it('names every rung instead of scattering z-index numbers', () => {
    for (const token of [
      '--layer-popover',
      '--layer-modal',
      '--layer-modal-nested',
      '--layer-fullbleed',
      '--layer-toast'
    ]) {
      expect(css).toContain(`${token}:`);
    }
  });

  it('has retired the ad-hoc bands the team overlays used', () => {
    // Everything outside the ladder's own documentation comment.
    const rules = css.slice(css.indexOf('--layer-toast:'));
    expect(rules).not.toMatch(/z-index:\s*45;/);
    expect(rules).not.toMatch(/z-index:\s*80;/);
  });

  it('puts a preview above a dialog, not underneath one', () => {
    const layer = (name: string) => Number(css.match(new RegExp(`${name}:\\s*(\\d+)`))?.[1]);
    // The exact bug: a preview opened while a modal was up rendered below it.
    expect(layer('--layer-fullbleed')).toBeGreaterThan(layer('--layer-modal'));
    // And a toast has to stay reachable above whatever raised it.
    expect(layer('--layer-toast')).toBeGreaterThan(layer('--layer-fullbleed'));
  });
});
