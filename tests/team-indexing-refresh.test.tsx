// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';

/**
 * A listing that keeps up with a scan that is still running.
 *
 * A space being indexed for the first time showed "76 files so far" in the header above a
 * folder that said it was empty. The rows were in the catalogue; nothing had asked for them
 * again. The listing is read once and then only when the person changes something — which is
 * right for every situation except the one where somebody else is writing to the catalogue.
 */

function row(name: string) {
  return {
    id: name,
    teamId: 'team',
    name,
    kind: 'folder' as const,
    category: null,
    mimeType: null,
    fileExtension: null,
    sizeBytes: null,
    driveFileId: `drive-${name}`,
    parentFolderId: null,
    modifiedAt: null,
    driveVersion: null,
    previewState: 'ready' as const,
    thumbnailReady: false
  };
}

/** The catalogue as the scan fills it: empty at first, three folders a moment later. */
function growingClient() {
  let calls = 0;
  return {
    calls: () => calls,
    listFolderPage: vi.fn(async () => {
      calls += 1;
      const rows = calls === 1 ? [] : [row('library'), row('SPY'), row('OneMediaCreo')];
      return { rows, total: rows.length, next: null };
    })
  };
}

function Listing({ client, revision }: { client: ReturnType<typeof growingClient>; revision: number }) {
  const page = useFolderPage({
    teamId: 'team',
    client: client as never,
    parentFolderId: null,
    revision
  });
  return <div data-testid="rows">{page.rows.map(item => item.name).join(',')}</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the folder listing during a first scan', () => {
  it('re-reads when the space says its catalogue moved', async () => {
    const client = growingClient();
    const view = render(<Listing client={client} revision={0} />);
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe(''));

    // What the workspace does on its timer while the storage health says "indexing".
    view.rerender(<Listing client={client} revision={1} />);

    await waitFor(() =>
      expect(screen.getByTestId('rows').textContent).toBe('library,SPY,OneMediaCreo')
    );
    expect(client.calls()).toBe(2);
  });

  it('does not re-read on its own while nothing says the catalogue changed', async () => {
    const client = growingClient();
    render(<Listing client={client} revision={0} />);
    await waitFor(() => expect(client.calls()).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 60));
    // A listing that polls when nobody is writing is a poll for its own sake.
    expect(client.calls()).toBe(1);
  });
});
