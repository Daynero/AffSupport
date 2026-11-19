// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { ToastProvider } from '../apps/web/src/components/toast';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { PreviewPane } from '../apps/web/src/team/explorer/PreviewPane';
import { forgetBrokenPictures } from '../apps/web/src/team/explorer/brokenPictures';
import { dropAutoGhost } from '../apps/web/src/lib/auto-crossfade';
import { resetMaterialNotes } from '../apps/web/src/team/materials/materialNotes';
import { teamApi } from '../apps/web/src/api/team';

/**
 * Another file in a card that is already open (058). The picture went blank and came back and
 * the note's row dropped out and returned on every press; the card as it was now stays up, as
 * a copy, until the next one has its picture.
 */

beforeAll(() => {
  // jsdom has no Web Animations; a copy is only made where it can be faded.
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => ({ finished: new Promise<void>(() => {}), cancel: () => {} })
  });
});

beforeEach(() => {
  vi.spyOn(teamApi, 'getMaterialNote').mockResolvedValue(null);
  vi.spyOn(teamApi, 'listMaterialTasks').mockResolvedValue([]);
});

afterEach(() => {
  dropAutoGhost();
  cleanup();
  forgetBrokenPictures();
  resetMaterialNotes();
  vi.restoreAllMocks();
});

const image = (id: string, name: string) =>
  ({
    id,
    teamId: 't-1',
    name,
    category: 'image',
    kind: 'image',
    driveFileId: `d-${id}`,
    parentFolderId: 'root',
    sizeBytes: 1000,
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'ready',
    thumbnailReady: true
  }) as unknown as TeamMaterialRow;

// Plain functions: the mocks above are restored after each test, and these must outlive that.
const client = {
  mintThumbnailSession: async () => ({
    endpoint: 'https://thumb.invalid',
    token: 'synthetic',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  }),
  thumbnailUrl: (_session: unknown, id: string) => `https://thumb.invalid/${id}`,
  listFolderTree: async () => []
} as never;

function Pane({ row }: { row: TeamMaterialRow }) {
  return (
    <ToastProvider>
      <TeamProvider
        realtime={false}
        initialTeams={[
          {
            id: 't-1',
            name: 'Space',
            role: 'editor',
            permissions: DEFAULT_ROLE_PERMISSIONS.editor,
            connectionState: 'connected' as const
          }
        ]}
      >
        <ExplorerProvider teamId="t-1" client={client} folderId={null}>
          <PreviewPane row={row} client={client} browseClient={client} onChanged={() => {}} />
        </ExplorerProvider>
      </TeamProvider>
    </ToastProvider>
  );
}

const live = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.team-explorer-pane:not([data-auto-ghost])')!;
const copies = (container: HTMLElement) =>
  container.querySelectorAll<HTMLElement>('[data-auto-ghost]');
const picture = (container: HTMLElement) => live(container).querySelector('img');

describe('another file in the open card (058)', () => {
  it('keeps the card that was there up, as a copy, while the next picture is on its way', async () => {
    const { container, rerender } = render(<Pane row={image('a', 'first.png')} />);
    await waitFor(() =>
      expect(picture(container)?.getAttribute('src')).toBe('https://thumb.invalid/a')
    );
    // The first picture fades in over its holder, on its own.
    expect(picture(container)!.hasAttribute('data-immediate')).toBe(false);
    expect(copies(container)).toHaveLength(0);
    fireEvent.load(picture(container)!);

    rerender(<Pane row={image('b', 'second.png')} />);
    // The card says the new name underneath; what is seen is the copy, still the first file.
    expect(live(container).querySelector('h3')!.textContent).toBe('second.png');
    expect(copies(container)).toHaveLength(1);
    const copy = copies(container)[0]!;
    expect(copy.querySelector('h3')!.textContent).toBe('first.png');
    expect(copy.querySelector('img')!.getAttribute('src')).toBe('https://thumb.invalid/a');
    expect(copy.hasAttribute('inert')).toBe(true);
    // The copy waits for this: the picture says it is not there yet …
    expect(picture(container)!.getAttribute('src')).toBe('https://thumb.invalid/b');
    expect(picture(container)!.getAttribute('aria-busy')).toBe('true');
    // … and when it is, it is there whole — the card's crossfade is the only fade.
    expect(picture(container)!.hasAttribute('data-immediate')).toBe(true);
    fireEvent.load(picture(container)!);
    expect(picture(container)!.hasAttribute('aria-busy')).toBe(false);
  });

  it('leaves a copy that is already up in charge when files are stepped through quickly', async () => {
    const { container, rerender } = render(<Pane row={image('a', 'first.png')} />);
    await waitFor(() => expect(picture(container)).not.toBeNull());
    rerender(<Pane row={image('b', 'second.png')} />);
    rerender(<Pane row={image('c', 'third.png')} />);
    expect(copies(container)).toHaveLength(1);
    expect(copies(container)[0]!.querySelector('h3')!.textContent).toBe('first.png');
    expect(live(container).querySelector('h3')!.textContent).toBe('third.png');
  });

  it('does not ask twice for a picture that has just failed', async () => {
    const { container, rerender } = render(<Pane row={image('a', 'first.png')} />);
    await waitFor(() => expect(picture(container)).not.toBeNull());
    fireEvent.error(picture(container)!);
    expect(picture(container)).toBeNull();
    expect(live(container).querySelector('.team-explorer-tile-icon')).not.toBeNull();

    rerender(<Pane row={image('b', 'second.png')} />);
    await waitFor(() => expect(picture(container)).not.toBeNull());
    // Back on the first: its icon at once, no empty box while the same request fails again.
    rerender(<Pane row={image('a', 'first.png')} />);
    expect(picture(container)).toBeNull();
    expect(live(container).querySelector('.team-explorer-tile-icon')).not.toBeNull();
  });
});
