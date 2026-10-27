// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  classifyCatalogImageName,
  type CatalogImageCapabilities,
  type CatalogImageImportJob
} from '@video-compressor/shared';
import type { CatalogImageClient } from '../apps/web/src/api/team-catalog-images';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { CatalogImageImport } from '../apps/web/src/team/product-catalog/CatalogImageImport';
import { requestCatalogImageGrant } from '../apps/web/src/team/product-catalog/useCatalogImageImport';
import { TeamApiError } from '../apps/web/src/api/team';
import { FolderPicker, type FolderPickerClient } from '../apps/web/src/team/catalog/FolderPicker';
import { analytics } from '../apps/web/src/analytics/service';

const transfer = vi.hoisted(() => ({ upload: vi.fn(async () => {}) }));
vi.mock('../apps/web/src/api/team-catalog-images', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/api/team-catalog-images')>()),
  uploadCatalogImage: transfer.upload
}));

const TEAM = '22000000-0000-4000-8000-0000000000aa';
const job = (state: CatalogImageImportJob['state'] = 'collecting'): CatalogImageImportJob => ({
  id: 'job',
  teamId: TEAM,
  sourceKind: 'local',
  state,
  revision: 1,
  counts: { total: 1, ready: 0, reused: 0, unclassified: 0, failed: 0, expired: 0 },
  entries: [
    {
      id: 'entry',
      clientFileKey: null,
      displayName: 'IMG_2031.png',
      declaredSize: 3,
      state: 'waiting_source',
      grantGeneration: 0,
      classification: classifyCatalogImageName('IMG_2031.png'),
      errorCode: null
    }
  ],
  hasMore: false,
  nextCursor: null
});

function fixture(enabled = true): CatalogImageClient {
  return {
    continueImport: vi.fn(async () => job('enumerating')),
    capabilities: vi.fn(async (): Promise<CatalogImageCapabilities> => ({
      enabled,
      importEnabled: enabled,
      canManage: true,
      contractVersion: 2,
      mode: 'v2'
    })),
    listImports: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
    beginImport: vi.fn(async () => job()),
    appendManifest: vi.fn(async () => job()),
    seal: vi.fn(async () => job('sealed')),
    grant: vi.fn(async () => ({
      url: 'https://account.r2.cloudflarestorage.com/staging/key',
      headers: {},
      expiresAt: '2099-01-01T00:00:00Z',
      generation: 1
    })),
    delivered: vi.fn(async (): Promise<CatalogImageImportJob> => ({
      ...job('running'),
      entries: [{ ...job().entries[0]!, state: 'staged' }]
    })),
    getImport: vi.fn(async () => job('sealed')),
    cancel: vi.fn(async () => job('cancelled')),
    retry: vi.fn(async () => job('running')),
    dictionary: vi.fn(async () => ({
      items: [],
      total: 0,
      revision: 1,
      hasMore: false,
      nextCursor: null
    })),
    inventory: vi.fn(async () => ({ revision: 1, pairs: [], unclassified: 0, total: 0 })),
    remove: vi.fn(async () => ({
      items: [],
      total: 0,
      revision: 2,
      hasMore: false,
      nextCursor: null
    })),
    revoke: vi.fn(async () => ({
      items: [],
      total: 0,
      revision: 2,
      hasMore: false,
      nextCursor: null
    }))
  };
}

function mount(
  client: CatalogImageClient,
  options: {
    legacySources?: () => Promise<readonly string[]>;
    onPool?: (count: number) => void;
    folderClient?: FolderPickerClient;
  } = {}
) {
  return render(
    <TeamProvider
      realtime={false}
      initialTeams={[
        {
          id: TEAM,
          name: 'Space',
          role: 'owner',
          permissions: DEFAULT_ROLE_PERMISSIONS.owner,
          connectionState: 'connected'
        }
      ]}
    >
      <CatalogImageImport
        teamId={TEAM}
        client={client}
        onPool={options.onPool ?? vi.fn()}
        legacySources={options.legacySources}
        folderClient={options.folderClient}
      />
    </TeamProvider>
  );
}

it('explains public publication before the explicit upload action', async () => {
  const client = fixture();
  mount(client);
  expect(await screen.findByText(/will be publicly accessible/iu)).toBeTruthy();
  expect(client.beginImport).not.toHaveBeenCalled();
  expect(transfer.upload).not.toHaveBeenCalled();
});
beforeEach(() => {
  localStorage.setItem('language', 'en');
  transfer.upload.mockClear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded upload-capacity backpressure', () => {
  it('waits when eight slots are occupied and retries the same grant intent after capacity is freed', async () => {
    vi.useFakeTimers();
    const client = fixture();
    let occupied = 8;
    const admitted = await fixture().grant('job', 'entry', {
      generation: 0,
      requestKey: 'same-grant'
    });
    vi.mocked(client.grant).mockImplementation(async () => {
      if (occupied === 8) throw new TeamApiError('IMAGE_UPLOAD_CAPACITY_BUSY', true);
      return admitted;
    });
    const waiting = vi.fn();
    const result = requestCatalogImageGrant(
      client,
      'job',
      job().entries[0]!,
      'same-grant',
      new AbortController().signal,
      waiting
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(client.grant).toHaveBeenCalledTimes(1);
    expect(waiting).toHaveBeenCalledWith(true);
    occupied = 7;
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(admitted);
    expect(vi.mocked(client.grant).mock.calls).toEqual([
      ['job', 'entry', { generation: 0, requestKey: 'same-grant' }],
      ['job', 'entry', { generation: 0, requestKey: 'same-grant' }]
    ]);
    expect(waiting.mock.calls).toEqual([[true], [false]]);
  });
  it('stops waiting immediately on cancellation and never retries true quota exhaustion', async () => {
    vi.useFakeTimers();
    const client = fixture();
    vi.mocked(client.grant).mockRejectedValue(new TeamApiError('IMAGE_UPLOAD_CAPACITY_BUSY', true));
    const controller = new AbortController();
    const result = requestCatalogImageGrant(
      client,
      'job',
      job().entries[0]!,
      'same-grant',
      controller.signal,
      vi.fn()
    );
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.grant).toHaveBeenCalledTimes(1);
    vi.mocked(client.grant).mockRejectedValue(new TeamApiError('IMAGE_QUOTA_EXCEEDED', false));
    await expect(
      requestCatalogImageGrant(
        client,
        'job',
        job().entries[0]!,
        'quota-grant',
        new AbortController().signal,
        vi.fn()
      )
    ).rejects.toMatchObject({ code: 'IMAGE_QUOTA_EXCEEDED' });
    expect(client.grant).toHaveBeenCalledTimes(2);
  });
  it('bounds capacity retries to four minutes', async () => {
    vi.useFakeTimers();
    const client = fixture();
    vi.mocked(client.grant).mockRejectedValue(new TeamApiError('IMAGE_UPLOAD_CAPACITY_BUSY', true));
    const result = requestCatalogImageGrant(
      client,
      'job',
      job().entries[0]!,
      'same-grant',
      new AbortController().signal,
      vi.fn()
    );
    const assertion = expect(result).rejects.toMatchObject({ code: 'IMAGE_UPLOAD_CAPACITY_BUSY' });
    await vi.advanceTimersByTimeAsync(240000);
    await assertion;
    expect(client.grant).toHaveBeenCalledTimes(49);
  });
});

describe('catalog image import', () => {
  it.each(['failed', 'partial'] as const)(
    'explains each rejected file in a %s local import without a job-level error',
    async state => {
      const client = fixture();
      const entries: CatalogImageImportJob['entries'] = [
        {
          ...job().entries[0]!,
          id: 'invalid-content',
          displayName: 'broken.png',
          state: 'failed',
          errorCode: 'IMAGE_CONTENT_INVALID'
        },
        {
          ...job().entries[0]!,
          id: 'conflicting-classification',
          displayName: 'hoodie_white_001.png',
          state: 'failed',
          errorCode: 'IMAGE_CLASSIFICATION_CONFLICT'
        }
      ];
      if (state === 'partial')
        entries.push({ ...job().entries[0]!, id: 'ready-random', state: 'ready' });
      const failed: CatalogImageImportJob = {
        ...job(state),
        entries,
        errorCode: null,
        counts: {
          total: entries.length,
          ready: state === 'partial' ? 1 : 0,
          reused: 0,
          unclassified: state === 'partial' ? 1 : 0,
          failed: 2,
          expired: 0
        }
      };
      vi.mocked(client.listImports).mockResolvedValue({
        items: [failed],
        hasMore: false,
        nextCursor: null
      });
      vi.mocked(client.getImport).mockResolvedValue(failed);
      mount(client);
      const brokenRow = (await screen.findByText('broken.png')).closest('li')!;
      const conflictRow = screen.getByText('hoodie_white_001.png').closest('li')!;
      expect(within(brokenRow).getByRole('alert').textContent).toBe(
        'Use a valid static PNG, JPEG or WebP picture with the correct orientation.'
      );
      expect(within(conflictRow).getByRole('alert').textContent).toBe(
        'These bytes already have a different classification, or the request changed. Refresh status and check the mapping.'
      );
      expect(screen.getAllByRole('alert')).toHaveLength(2);
      expect(brokenRow.textContent).not.toContain('IMAGE_CONTENT_INVALID');
      expect(conflictRow.textContent).not.toContain('IMAGE_CLASSIFICATION_CONFLICT');
      expect(screen.getByRole('button', { name: 'Retry unfinished pictures' })).toBeTruthy();
      if (state === 'partial') {
        const readyRow = screen.getByText('IMG_2031.png').closest('li')!;
        expect(within(readyRow).queryByRole('alert')).toBeNull();
        expect(within(readyRow).getByText(/Ready.*Random selection/u)).toBeTruthy();
      }
    }
  );
  it('shows a ready unclassified picture as random selection without an error alert', async () => {
    const client = fixture();
    const ready: CatalogImageImportJob = {
      ...job('completed'),
      counts: { ...job().counts, ready: 1, unclassified: 1 },
      entries: [{ ...job().entries[0]!, state: 'ready' }]
    };
    vi.mocked(client.listImports).mockResolvedValue({
      items: [ready],
      hasMore: false,
      nextCursor: null
    });
    vi.mocked(client.getImport).mockResolvedValue(ready);
    mount(client);
    const row = (await screen.findByText('IMG_2031.png')).closest('li')!;
    expect(within(row).getByText(/Ready.*Random selection/u)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('resumes a selected local source on a later page instead of admitting another job', async () => {
    const client = fixture();
    const counts = { ...job().counts, total: 101, ready: 100 };
    const first: CatalogImageImportJob = {
      ...job('running'),
      counts,
      entries: Array.from({ length: 100 }, (_, index) => ({
        ...job().entries[0]!,
        id: `ready-${index}`,
        displayName: `ready-${index}.png`,
        state: 'ready' as const
      })),
      hasMore: true,
      nextCursor: 'ready-page-cursor'
    };
    const later: CatalogImageImportJob = {
      ...job('running'),
      counts,
      entries: [{ ...job().entries[0]!, id: 'waiting-later', displayName: 'later.png' }]
    };
    vi.mocked(client.listImports).mockResolvedValue({
      items: [first],
      hasMore: false,
      nextCursor: null
    });
    vi.mocked(client.getImport).mockImplementation(async (_id, cursor) => (cursor ? later : first));
    mount(client);
    await screen.findByText('Processing pictures');
    expect(client.getImport).not.toHaveBeenCalledWith('job', 'ready-page-cursor');
    fireEvent.drop(await screen.findByRole('group', { name: 'Drop pictures here' }), {
      dataTransfer: { files: [new File(['abc'], 'later.png', { type: 'image/png' })] }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze and upload' }));
    await waitFor(() =>
      expect(client.grant).toHaveBeenCalledWith(
        'job',
        'waiting-later',
        expect.objectContaining({ generation: 0 })
      )
    );
    expect(client.getImport).toHaveBeenCalledWith('job', 'ready-page-cursor');
    expect(client.beginImport).not.toHaveBeenCalled();
    expect(client.appendManifest).not.toHaveBeenCalled();
    expect(client.seal).not.toHaveBeenCalled();
  });
  it.each(['remove', 'revoke'] as const)(
    'records %s intent, acceptance and only React-visible completion without image content',
    async action => {
      const client = fixture();
      const publicationId = '22000000-0000-4000-8000-0000000000cc';
      const entry = {
        id: 'pool-entry',
        publicationId,
        publicUrl: 'https://private-image.example/photo.png',
        classification: classifyCatalogImageName('IMG_2031.png'),
        revision: 1
      };
      const empty = { items: [], total: 0, revision: 2, hasMore: false, nextCursor: null };
      vi.mocked(client.dictionary)
        .mockResolvedValueOnce({ ...empty, items: [entry], total: 1, revision: 1 })
        .mockResolvedValue(empty);
      vi.mocked(client.remove).mockResolvedValue(empty);
      vi.mocked(client.revoke).mockResolvedValue(empty);
      const observed: Array<{ name: string; properties: Record<string, unknown> }> = [];
      vi.spyOn(analytics, 'track').mockImplementation((name, input) => {
        const properties = input as Record<string, unknown>;
        if (properties.flow_step === 'catalog_image_pool') {
          if (name === 'operation_completed')
            expect(screen.queryByRole('button', { name: 'Remove from pool' })).toBeNull();
          observed.push({ name, properties });
        }
      });
      mount(client);
      fireEvent.click(
        await screen.findByRole('button', {
          name: action === 'remove' ? 'Remove from pool' : 'Revoke publication'
        })
      );
      if (action === 'revoke')
        fireEvent.click(
          within(await screen.findByRole('dialog')).getByRole('button', {
            name: 'Revoke publication'
          })
        );
      await waitFor(() =>
        expect(observed.map(item => item.name)).toEqual([
          'operation_started',
          'operation_stage_completed',
          'operation_completed'
        ])
      );
      expect(observed.map(item => item.properties.action_identifier)).toEqual([
        `${action}_requested`,
        `${action}_accepted`,
        `${action}_result_visible`
      ]);
      expect(new Set(observed.map(item => item.properties.flow_id)).size).toBe(1);
      expect(observed.every(item => item.properties.run_id === publicationId)).toBe(true);
      expect(JSON.stringify(observed)).not.toMatch(/private-image|IMG_2031|https:/u);
      if (action === 'revoke') expect(screen.getByText(/Revocation requested/)).toBeTruthy();
    }
  );
  it('records a pool mutation failure without claiming visible success', async () => {
    const client = fixture();
    const entry = {
      id: 'pool-entry',
      publicationId: '22000000-0000-4000-8000-0000000000cc',
      publicUrl: 'https://media.example/photo.png',
      classification: classifyCatalogImageName('IMG_2031.png'),
      revision: 1
    };
    vi.mocked(client.dictionary).mockResolvedValue({
      items: [entry],
      total: 1,
      revision: 1,
      hasMore: false,
      nextCursor: null
    });
    vi.mocked(client.remove).mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false));
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    mount(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from pool' }));
    await screen.findByRole('alert');
    const events = track.mock.calls.filter(
      ([, input]) => (input as Record<string, unknown>).flow_step === 'catalog_image_pool'
    );
    expect(events.map(([name]) => name)).toEqual(['operation_started', 'operation_failed']);
    expect(events[1]?.[1]).toMatchObject({ error_code: 'PERMISSION_DENIED' });
    expect(screen.getByRole('button', { name: 'Remove from pool' })).toBeTruthy();
  });
  it('keeps pending legacy import status and cancellation available when new uploads are disabled', async () => {
    const client = fixture(false);
    vi.mocked(client.capabilities).mockResolvedValue({
      enabled: false,
      importEnabled: false,
      canManage: true,
      contractVersion: 2,
      mode: 'legacy'
    });
    vi.mocked(client.listImports).mockResolvedValue({
      items: [job('sealed')],
      hasMore: false,
      nextCursor: null
    });
    mount(client);
    expect(await screen.findByText('File list ready')).toBeTruthy();
    expect(client.listImports).toHaveBeenCalledWith(TEAM);
    expect(client.inventory).toHaveBeenCalledWith(TEAM);
    expect(client.dictionary).toHaveBeenCalledWith(TEAM);
    expect(screen.queryByRole('button', { name: 'Analyze and upload' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
    await waitFor(() =>
      expect(client.cancel).toHaveBeenCalledWith('job', {
        revision: 1,
        idempotencyKey: expect.any(String)
      })
    );
    expect(client.beginImport).not.toHaveBeenCalled();
    expect(transfer.upload).not.toHaveBeenCalled();
  });
  it('requires an actual material folder and never submits the space-root sentinel to R2', async () => {
    const client = fixture();
    const folderId = '22000000-0000-4000-8000-0000000000bb';
    const folderClient: FolderPickerClient = {
      listMaterials: vi.fn(async (_team, parent) =>
        parent === null
          ? [
              {
                id: folderId,
                teamId: TEAM,
                providerId: 'drive-folder',
                name: 'Clothing',
                kind: 'folder' as const,
                category: null
              }
            ]
          : []
      )
    };
    mount(client, { folderClient });
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a Google Drive folder' }));
    const root = await screen.findByRole('button', { name: 'Select the space root' });
    expect((root as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(root);
    expect(client.beginImport).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Clothing' }));
    const select = await screen.findByRole('button', { name: 'Select “Clothing”' });
    expect((select as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(select);
    expect(await screen.findByText('Selected folder: Clothing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze and upload' }));
    await waitFor(() =>
      expect(client.beginImport).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceKind: 'drive',
          sourceMaterialIds: [folderId]
        })
      )
    );
    expect(JSON.stringify(vi.mocked(client.beginImport).mock.calls)).not.toContain('"root"');
  });
  it('preserves selecting the root by default for existing destination flows', async () => {
    const select = vi.fn();
    render(
      <FolderPicker
        teamId={TEAM}
        client={{ listMaterials: async () => [] }}
        title="Choose destination"
        onSelect={select}
        onClose={vi.fn()}
      />
    );
    const root = await screen.findByRole('button', { name: 'Select the space root' });
    expect((root as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(root);
    expect(select).toHaveBeenCalledWith({ id: 'root', name: 'Space root' });
  });
  it('shows a localized Drive enumeration cause and allows retry before any files were admitted', async () => {
    const client = fixture();
    const failed: CatalogImageImportJob = {
      ...job('failed'),
      sourceKind: 'drive',
      entries: [],
      counts: { total: 0, ready: 0, reused: 0, unclassified: 0, failed: 0, expired: 0 },
      errorCode: 'IMAGE_SOURCE_UNAVAILABLE'
    };
    vi.mocked(client.listImports).mockResolvedValue({
      items: [failed],
      hasMore: false,
      nextCursor: null
    });
    vi.mocked(client.getImport).mockResolvedValue(failed);
    mount(client);
    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/source/i);
    expect(message.textContent).not.toContain('IMAGE_SOURCE_UNAVAILABLE');
    fireEvent.click(screen.getByRole('button', { name: 'Retry unfinished pictures' }));
    await waitFor(() =>
      expect(client.retry).toHaveBeenCalledWith('job', { idempotencyKey: expect.any(String) })
    );
  });
  it('imports saved Drive sources only on explicit action and preserves the legacy pool summary', async () => {
    const client = fixture();
    vi.mocked(client.capabilities).mockResolvedValue({
      enabled: true,
      importEnabled: true,
      canManage: true,
      contractVersion: 2,
      mode: 'legacy'
    });
    const legacySources = vi.fn(async () => ['saved-folder', 'saved-file']);
    const onPool = vi.fn();
    mount(client, { legacySources, onPool });
    const action = await screen.findByRole('button', {
      name: 'Import current image sources to R2'
    });
    const publicNotice = screen.getByText(/will be publicly accessible/iu);
    expect(publicNotice.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(legacySources).not.toHaveBeenCalled();
    expect(client.beginImport).not.toHaveBeenCalled();
    expect(onPool).not.toHaveBeenCalled();
    fireEvent.click(action);
    await waitFor(() =>
      expect(client.beginImport).toHaveBeenCalledWith({
        teamId: TEAM,
        sourceKind: 'drive',
        idempotencyKey: expect.any(String),
        sourceMaterialIds: ['saved-folder', 'saved-file']
      })
    );
    expect(transfer.upload).not.toHaveBeenCalled();
  });
  it('refuses to silently truncate more than 100 saved Drive sources', async () => {
    const client = fixture();
    vi.mocked(client.capabilities).mockResolvedValue({
      enabled: true,
      importEnabled: true,
      canManage: true,
      contractVersion: 2,
      mode: 'legacy'
    });
    mount(client, {
      legacySources: async () => Array.from({ length: 101 }, (_, index) => `source-${index}`)
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Import current image sources to R2' })
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(client.beginImport).not.toHaveBeenCalled();
  });
  it('offers explicit recovery for expired sources without restricting retry to a visible page', async () => {
    const client = fixture();
    const expired = {
      ...job('expired'),
      counts: { ...job().counts, expired: 1 },
      entries: [{ ...job().entries[0]!, state: 'expired' as const }]
    };
    vi.mocked(client.listImports).mockResolvedValue({
      items: [expired],
      hasMore: false,
      nextCursor: null
    });
    vi.mocked(client.getImport).mockResolvedValue(expired);
    mount(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry unfinished pictures' }));
    await waitFor(() =>
      expect(client.retry).toHaveBeenCalledWith('job', {
        idempotencyKey: expect.any(String)
      })
    );
  });
  it('explains ordinary random pictures and keeps a disabled installation safe', async () => {
    const client = fixture(false);
    mount(client);
    expect(await screen.findByText(/R2 uploads are not enabled/)).toBeTruthy();
    expect(screen.getByText(/ordinary pictures without special names/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Analyze and upload' })).toBeNull();
    expect(client.beginImport).not.toHaveBeenCalled();
  });

  it('does not publish on drop; one explicit action admits and uploads normal pictures', async () => {
    const client = fixture();
    mount(client);
    const drop = await screen.findByRole('group', { name: 'Drop pictures here' });
    fireEvent.drop(drop, {
      dataTransfer: { files: [new File(['abc'], 'IMG_2031.png', { type: 'image/png' })] }
    });
    expect(await screen.findByText('Queued: 1')).toBeTruthy();
    expect(client.beginImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze and upload' }));
    await waitFor(() =>
      expect(client.delivered).toHaveBeenCalledWith(
        'job',
        'entry',
        expect.objectContaining({ grantGeneration: 1 })
      )
    );
    expect(client.beginImport).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'local', teamId: TEAM })
    );
    expect(transfer.upload).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/Random selection/).length).toBeGreaterThan(0);
  });

  it('discovers a pending import after reload without a local job ID', async () => {
    const client = fixture();
    vi.mocked(client.listImports).mockResolvedValue({
      items: [job('sealed')],
      hasMore: false,
      nextCursor: null
    });
    mount(client);
    expect(await screen.findByText(/Some local files have not been transferred/)).toBeTruthy();
    expect(client.getImport).toHaveBeenCalledWith('job');
    expect(client.beginImport).not.toHaveBeenCalled();
  });

  it('keeps the upload concurrency at two and waits for all started transfers on failure', async () => {
    const client = fixture();
    const filenames = ['IMG_1.png', 'IMG_2.png', 'IMG_3.png'];
    const snapshot = {
      ...job('sealed'),
      entries: filenames.map((displayName, index) => ({
        ...job().entries[0]!,
        id: `entry-${index}`,
        displayName
      }))
    };
    vi.mocked(client.seal).mockResolvedValue(snapshot);
    vi.mocked(client.getImport).mockResolvedValue(snapshot);
    const pending: Array<() => void> = [];
    transfer.upload.mockImplementation(() => new Promise<void>(resolve => pending.push(resolve)));
    mount(client);
    fireEvent.drop(await screen.findByRole('group', { name: 'Drop pictures here' }), {
      dataTransfer: { files: filenames.map(name => new File(['abc'], name, { type: 'image/png' })) }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze and upload' }));
    await waitFor(() => expect(transfer.upload).toHaveBeenCalledTimes(2));
    await act(async () => {
      pending.shift()?.();
    });
    await waitFor(() => expect(transfer.upload).toHaveBeenCalledTimes(3));
    await act(async () => {
      for (const complete of pending) complete();
    });
    transfer.upload.mockImplementation(async () => {});
  });
});
