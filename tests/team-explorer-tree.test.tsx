// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamFolderNode } from '@video-compressor/shared';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { FolderTree } from '../apps/web/src/team/explorer/FolderTree';
import { Breadcrumb } from '../apps/web/src/team/explorer/Breadcrumb';

/**
 * Feature 011 (T023): the tree shows every level from one read, stays bounded
 * by only rendering what is expanded, says "listing…" for a folder whose last
 * page has not landed, and moves under the keyboard the way a tree should.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TEAM = 'team-1';

/** A four-deep tree with 3,000 folders: 30 top-level × 10 × 10 under two of them. */
function bigTree(): TeamFolderNode[] {
  const nodes: TeamFolderNode[] = [];
  const node = (id: string, parent: string, name: string, extra: Partial<TeamFolderNode> = {}) =>
    nodes.push({
      id: `uuid-${id}`,
      driveFileId: id,
      parentFolderId: parent,
      selectionId: null,
      name,
      indexedAt: '2026-08-27T00:00:00.000Z',
      childFolderCount: 0,
      childFileCount: 3,
      thumbnailReadyCount: 0,
      ...extra
    });
  for (let a = 0; a < 30; a += 1) {
    node(`a${a}`, 'root', `Top ${a}`, { childFolderCount: a < 2 ? 10 : 0 });
    if (a >= 2) continue;
    for (let b = 0; b < 10; b += 1) {
      node(`a${a}b${b}`, `a${a}`, `Mid ${a}.${b}`, { childFolderCount: 10 });
      for (let c = 0; c < 10; c += 1) {
        node(`a${a}b${b}c${c}`, `a${a}b${b}`, `Leaf ${a}.${b}.${c}`, {
          childFolderCount: c === 0 ? 1 : 0
        });
        if (c === 0)
          node(`a${a}b${b}c${c}d`, `a${a}b${b}c${c}`, `Deep ${a}.${b}`, { indexedAt: null });
      }
    }
  }
  return nodes;
}

function renderTree(nodes: TeamFolderNode[], folderId: string | null = null) {
  const client = { listFolderTree: vi.fn().mockResolvedValue(nodes) };
  const onFolderChange = vi.fn();
  render(
    <ExplorerProvider
      teamId={TEAM}
      client={client}
      folderId={folderId}
      onFolderChange={onFolderChange}
    >
      <Breadcrumb />
      <FolderTree />
    </ExplorerProvider>
  );
  return { client, onFolderChange };
}

describe('FolderTree', () => {
  it('renders the top level from one read and expands to depth four without a second call', async () => {
    const user = userEvent.setup();
    const nodes = bigTree();
    const { client } = renderTree(nodes);
    const tree = await screen.findByRole('tree');
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(30);
    expect(client.listFolderTree).toHaveBeenCalledTimes(1);

    await user.click(within(tree).getAllByRole('button', { name: 'Expand' })[0]!);
    await user.click(screen.getByRole('treeitem', { name: /Mid 0\.0/ }).querySelector('button')!);
    await user.click(
      screen.getByRole('treeitem', { name: /Leaf 0\.0\.0/ }).querySelector('button')!
    );
    const deep = await screen.findByRole('treeitem', { name: /Deep 0\.0/ });
    expect(deep?.getAttribute('aria-level')).toBe('4');
    expect(within(deep).getByText('listing…')).toBeTruthy();
    expect(client.listFolderTree).toHaveBeenCalledTimes(1);
    // Collapsed siblings are not in the DOM: the tree stays bounded.
    expect(screen.queryByRole('treeitem', { name: /Mid 1\.0/ })).toBeNull();
  });

  it("keeps the open folder's ancestors expanded and the path clickable at every segment", async () => {
    const user = userEvent.setup();
    const { onFolderChange } = renderTree(bigTree(), 'a1b2c3');
    await screen.findByRole('tree');
    const current = await screen.findByRole('treeitem', { name: /Leaf 1\.2\.3/ });
    expect(current?.getAttribute('aria-current')).toBe('location');
    const crumbs = screen.getByRole('navigation', { name: 'Location' });
    expect(
      within(crumbs)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual(['All files', '/Top 1', '/Mid 1.2', '/Leaf 1.2.3']);
    await user.click(within(crumbs).getByRole('button', { name: 'Mid 1.2' }));
    expect(onFolderChange).toHaveBeenCalledWith('a1b2');
    await user.click(within(crumbs).getByRole('button', { name: 'All files' }));
    expect(onFolderChange).toHaveBeenCalledWith(null);
  });

  it('moves, expands, collapses and opens from the keyboard', async () => {
    const user = userEvent.setup();
    const { onFolderChange } = renderTree(bigTree());
    const tree = await screen.findByRole('tree');
    const first = within(tree).getAllByRole('treeitem')[0]!;
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-folder-id')).toBe('a1');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('data-folder-id')).toBe('a1b0');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.getAttribute('data-folder-id')).toBe('a1');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{Enter}');
    expect(onFolderChange).toHaveBeenCalledWith('a1');
  });

  it('says so when the read fails and when there are no folders', async () => {
    const failing = { listFolderTree: vi.fn().mockRejectedValue(new Error('boom')) };
    const { unmount } = render(
      <ExplorerProvider teamId={TEAM} client={failing}>
        <FolderTree />
      </ExplorerProvider>
    );
    expect(await screen.findByText(/Could not read this space/)).toBeTruthy();
    unmount();
    renderTree([]);
    await waitFor(() => expect(screen.getByText('No folders yet.')).toBeTruthy());
  });
});
