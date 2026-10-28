// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  classifyCatalogImageName,
  type CatalogImageCapabilities,
  type CatalogImageImportJob,
  type CatalogImageStorage,
  type CatalogImageLibraryEntry
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

const emptyStorage = (): CatalogImageStorage => ({
  limitBytes: 100_000_000,
  limitImages: 500,
  usedBytes: 0,
  reservedBytes: 0,
  pendingDeletionBytes: 0,
  retainedBytes: 0,
  libraryBytes: 0,
  totalImages: 0,
  availableBytes: 100_000_000,
  teamBytes: 0,
  otherTeamBytes: 0
});
function fixture(enabled = true): CatalogImageClient {
  return {
    readStorage: vi.fn(async () => emptyStorage()),
    readLibrary: vi.fn(async () => ({
      items: [],
      total: 0,
      revision: 1,
      hasMore: false,
      nextCursor: null
    })),
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
    onPool?: (count: number | null) => void;
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

async function openSurface(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Image actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}
async function openUpload() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add images' }));
}
async function openStatus() {
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
}
function closeSurface() {
  fireEvent.keyDown(document, { key: 'Escape' });
}
async function openPictureActions() {
  fireEvent.click(await screen.findByRole('button', { name: /^Image actions:/ }));
}

it('keeps the gallery concise and preserves a queued selection when Add is closed', async () => {
  const client = fixture();
  mount(client);
  await screen.findByRole('button', { name: 'Add images' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText(/^Storage: /)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Drop pictures here' })).toBeNull();
  expect(screen.queryByText(/Processing:.*Pending cleanup:/)).toBeNull();
  await openUpload();
  fireEvent.drop(screen.getByRole('group', { name: 'Drop pictures here' }), {
    dataTransfer: { files: [new File(['abc'], 'selected.png', { type: 'image/png' })] }
  });
  expect(await screen.findByText('Queued: 1')).toBeTruthy();
  closeSurface();
  await openUpload();
  expect(screen.getByText('Queued: 1')).toBeTruthy();
  expect(screen.getByText('selected.png')).toBeTruthy();
  expect(client.beginImport).not.toHaveBeenCalled();
  expect(transfer.upload).not.toHaveBeenCalled();
});

it('keeps an uncertain current import visible without opening history and only checks its result', async () => {
  const client = fixture();
  const uncertain = job('awaiting_reconciliation');
  vi.mocked(client.listImports).mockResolvedValue({
    items: [uncertain],
    hasMore: false,
    nextCursor: null
  });
  vi.mocked(client.getImport).mockResolvedValue(uncertain);
  mount(client);
  fireEvent.click(await screen.findByRole('button', { name: 'Check status' }));
  await waitFor(() => expect(client.listImports).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/Status checked. The server has not confirmed/)).toBeTruthy();
  expect(client.retry).not.toHaveBeenCalled();
  expect(client.beginImport).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not hide an uncertain import when a completed upload is selected from history', async () => {
  const client = fixture();
  const uncertain = { ...job('awaiting_reconciliation'), id: 'uncertain-job' };
  const completed = {
    ...job('completed'),
    id: 'completed-job',
    counts: { ...job().counts, ready: 1 }
  };
  vi.mocked(client.listImports).mockResolvedValue({
    items: [uncertain, completed],
    hasMore: false,
    nextCursor: null
  });
  vi.mocked(client.getImport).mockImplementation(async id =>
    id === completed.id ? completed : uncertain
  );
  mount(client);
  await screen.findByRole('button', { name: 'Check status' });
  await openSurface('Recent uploads');
  fireEvent.click(screen.getByRole('button', { name: /Completed.*1\/1/ }));
  await waitFor(() => expect(client.getImport).toHaveBeenCalledWith(completed.id));
  closeSurface();
  expect(await screen.findByRole('button', { name: 'Check status' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry unfinished pictures' })).toBeNull();
  expect(client.beginImport).not.toHaveBeenCalled();
  expect(client.retry).not.toHaveBeenCalled();
});

it('explains public publication before the explicit upload action', async () => {
  const client = fixture();
  mount(client);
  await openUpload();
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
  it('loads identifying thumbnails lazily only in the expanded management library, excluding pending cleanup', async () => {
    const client = fixture();
    const base: CatalogImageLibraryEntry = {
      id: 'matched-entry',
      publicationId: '22000000-0000-4000-8000-0000000000cc',
      publicUrl: 'https://media.example/v1/matched',
      classification: classifyCatalogImageName('hoodie_black_001.png'),
      revision: 1,
      sizeBytes: 1000,
      active: false,
      inUse: false,
      publicationState: 'ready'
    };
    vi.mocked(client.readLibrary).mockResolvedValue({
      items: [
        base,
        {
          ...base,
          id: 'random-entry',
          publicationId: '22000000-0000-4000-8000-0000000000cd',
          publicUrl: 'https://media.example/v1/random',
          classification: classifyCatalogImageName('IMG_2031.png')
        },
        {
          ...base,
          id: 'pending-entry',
          publicationId: '22000000-0000-4000-8000-0000000000ce',
          publicUrl: 'https://media.example/v1/pending',
          publicationState: 'revoking'
        }
      ],
      total: 3,
      revision: 1,
      hasMore: false,
      nextCursor: null
    });
    mount(client);
    await waitFor(() => expect(client.readLibrary).toHaveBeenCalled());
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    await openSurface('Picture storage');

    const matched = await screen.findByRole('img', { name: 'Hoodie / black' });
    const random = screen.getByRole('img', { name: 'Random selection' });
    for (const image of [matched, random]) {
      expect(image.getAttribute('loading')).toBe('lazy');
      expect(image.getAttribute('decoding')).toBe('async');
      expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
    expect(matched.getAttribute('src')).toBe(base.publicUrl);
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(document.querySelector('img[src="https://media.example/v1/pending"]')).toBeNull();
    expect(
      within(matched.closest('li')!)
        .getByRole('link', { name: 'Open picture' })
        .getAttribute('href')
    ).toBe(base.publicUrl);
    closeSurface();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });
  it('shows the owner-account quota and charged processing, cleanup and other-workspace bytes', async () => {
    const client = fixture();
    vi.mocked(client.readStorage).mockResolvedValue({
      ...emptyStorage(),
      usedBytes: 90_000_000,
      reservedBytes: 5_000_000,
      pendingDeletionBytes: 10_000_000,
      retainedBytes: 20_000_000,
      libraryBytes: 55_000_000,
      totalImages: 120,
      availableBytes: 10_000_000,
      teamBytes: 60_000_000,
      otherTeamBytes: 30_000_000
    });
    mount(client);
    await openSurface('Picture storage');
    expect(await screen.findByText('90 MB used · 10 MB free · 100 MB total')).toBeTruthy();
    expect(
      screen.getByText(/Processing: 5 MB. Pending cleanup: 10 MB. Outside selection: 20 MB./u)
    ).toBeTruthy();
    expect(screen.getByText('This workspace: 60 MB. Other owned workspaces: 30 MB.')).toBeTruthy();
    expect(screen.getByText(/Shared storage across the owner’s spaces\. · 120\/500/u)).toBeTruthy();
  });
  it('does not present zero usage when the storage read failed, and keeps the usable pool', async () => {
    const client = fixture();
    vi.mocked(client.readStorage).mockRejectedValue(
      new TeamApiError('IMAGE_PROVIDER_UNAVAILABLE', true)
    );
    vi.mocked(client.inventory).mockResolvedValue({
      revision: 1,
      pairs: [],
      unclassified: 2,
      total: 2
    });
    mount(client);
    expect((await screen.findAllByText(/Storage usage is unavailable/u)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Storage: /u)).toBeNull();
    expect(screen.getByText('Images: 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add images' })).toBeTruthy();
  });
  it('retains the last usage with an explicit stale warning when a refresh fails', async () => {
    const client = fixture();
    vi.mocked(client.readStorage)
      .mockResolvedValueOnce({
        ...emptyStorage(),
        usedBytes: 25_000_000,
        teamBytes: 25_000_000,
        availableBytes: 75_000_000,
        totalImages: 4
      })
      .mockRejectedValue(new TeamApiError('IMAGE_PROVIDER_UNAVAILABLE', true));
    mount(client);
    await openSurface('Picture storage');
    expect(await screen.findByText('25 MB used · 75 MB free · 100 MB total')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(
      await within(screen.getByRole('dialog', { name: 'Picture storage' })).findByText(
        /displayed balance is from the last successful check/u
      )
    ).toBeTruthy();
    expect(screen.getByText('25 MB used · 75 MB free · 100 MB total')).toBeTruthy();
    expect(screen.queryByText(/^0 B used/u)).toBeNull();
  });
  it('shows uncertain cleanup without offering another delete request', async () => {
    const client = fixture();
    vi.mocked(client.readStorage).mockResolvedValue({
      ...emptyStorage(),
      usedBytes: 1000,
      pendingDeletionBytes: 1000,
      retainedBytes: 0,
      libraryBytes: 0,
      totalImages: 1,
      availableBytes: 99_999_000,
      teamBytes: 1000
    });
    vi.mocked(client.readLibrary).mockResolvedValue({
      items: [
        {
          id: 'uncertain-entry',
          publicationId: '22000000-0000-4000-8000-0000000000cc',
          publicUrl: 'https://media.example/v1/uncertain',
          classification: classifyCatalogImageName('IMG_2031.png'),
          revision: 2,
          sizeBytes: 1000,
          active: false,
          inUse: true,
          publicationState: 'purge_unknown'
        }
      ],
      total: 1,
      revision: 2,
      hasMore: false,
      nextCursor: null
    });
    mount(client);
    expect(
      await screen.findByText(/Cleanup outcome is uncertain; space is still charged/u)
    ).toBeTruthy();
    await openSurface('Picture storage');
    expect(
      await within(screen.getByRole('dialog', { name: 'Picture storage' })).findByText(
        /Cleanup outcome is uncertain; space is still charged/u
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete stored picture' })).toBeNull();
    expect(client.revoke).not.toHaveBeenCalled();
  });
  it('allows a viewer to read usage without requesting the manager-only library or rendering its controls', async () => {
    const client = fixture();
    vi.mocked(client.capabilities).mockResolvedValue({
      enabled: true,
      importEnabled: true,
      canManage: false,
      contractVersion: 2,
      mode: 'v2'
    });
    mount(client);
    await openSurface('Picture storage');
    expect(await screen.findByText('0 B used · 100 MB free · 100 MB total')).toBeTruthy();
    expect(client.readStorage).toHaveBeenCalledWith(TEAM);
    expect(client.readLibrary).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Manage stored pictures' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Analyze and upload' })).toBeNull();
  });
  it('deletes a retained in-use picture explicitly, keeps capacity charged while pending, then reads freed capacity', async () => {
    const client = fixture();
    const entry: CatalogImageLibraryEntry = {
      id: 'retained-pool-entry',
      publicationId: '22000000-0000-4000-8000-0000000000cc',
      publicUrl: 'https://media.example/v1/retained',
      classification: classifyCatalogImageName('hoodie_black_001.png'),
      revision: 3,
      sizeBytes: 1_000_000,
      active: false,
      inUse: true,
      publicationState: 'ready'
    };
    const full = {
      ...emptyStorage(),
      usedBytes: 100_000_000,
      libraryBytes: 0,
      reservedBytes: 99_000_000,
      retainedBytes: 1_000_000,
      teamBytes: 100_000_000,
      totalImages: 21,
      availableBytes: 0
    };
    vi.mocked(client.readStorage)
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce({
        ...full,
        pendingDeletionBytes: 1_000_000,
        retainedBytes: 0
      })
      .mockResolvedValue({
        ...emptyStorage(),
        usedBytes: 99_000_000,
        reservedBytes: 99_000_000,
        totalImages: 20,
        availableBytes: 1_000_000,
        teamBytes: 99_000_000
      });
    const page = { items: [entry], total: 1, revision: 1, hasMore: false, nextCursor: null };
    vi.mocked(client.readLibrary)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({
        ...page,
        items: [{ ...entry, publicationState: 'revoking' }]
      })
      .mockResolvedValueOnce({ ...page, items: [{ ...entry, publicationState: 'revoking' }] })
      .mockResolvedValue({ ...page, items: [], total: 0 });
    mount(client);
    await openSurface('Picture storage');
    expect(
      await within(screen.getByRole('dialog', { name: 'Picture storage' })).findByText(
        /Storage is full\./u
      )
    ).toBeTruthy();

    expect(screen.getByText('Outside selection')).toBeTruthy();
    expect(screen.getByText('Used by catalogs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete stored picture' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete stored picture' });
    expect(within(dialog).getByText(/link will stop working in existing catalogs/u)).toBeTruthy();
    expect(within(dialog).getByText(/only after confirmed cleanup/u)).toBeTruthy();
    expect(client.revoke).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete stored picture' }));
    await waitFor(() =>
      expect(client.revoke).toHaveBeenCalledWith(entry.publicationId, {
        revision: 3,
        idempotencyKey: expect.any(String)
      })
    );
    expect(await screen.findByText(/Pending cleanup: 1 MB/u)).toBeTruthy();
    expect(
      within(screen.getByRole('dialog', { name: 'Picture storage' })).getByText(
        'Cleanup pending; space is not free yet'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete stored picture' })).toBeNull();
    expect(screen.getByText('100 MB used · 0 B free · 100 MB total')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(await screen.findByText('99 MB used · 1 MB free · 100 MB total')).toBeTruthy();
    expect(screen.queryByText(/Storage is full\./u)).toBeNull();
    closeSurface();
    await openUpload();
    fireEvent.drop(screen.getByRole('group', { name: 'Drop pictures here' }), {
      dataTransfer: { files: [new File(['abc'], 'next.png', { type: 'image/png' })] }
    });
    expect(
      (screen.getByRole('button', { name: 'Analyze and upload' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
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
      await openStatus();
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
      expect(
        screen.getAllByRole('button', { name: 'Retry unfinished pictures' }).at(-1)!
      ).toBeTruthy();
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
    await openStatus();
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
    await openUpload();
    await screen.findByText(/Processing pictures/);
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
            expect(screen.queryByRole('img', { name: 'Random selection' })).toBeNull();
          observed.push({ name, properties });
        }
      });
      mount(client);
      await openPictureActions();
      fireEvent.click(
        await screen.findByRole('menuitem', {
          name: action === 'remove' ? 'Remove from selection' : 'Revoke publication'
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
    await openPictureActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from selection' }));
    await screen.findByRole('alert');
    const events = track.mock.calls.filter(
      ([, input]) => (input as Record<string, unknown>).flow_step === 'catalog_image_pool'
    );
    expect(events.map(([name]) => name)).toEqual(['operation_started', 'operation_failed']);
    expect(events[1]?.[1]).toMatchObject({ error_code: 'PERMISSION_DENIED' });
    expect(screen.getByRole('button', { name: /^Image actions:/ })).toBeTruthy();
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
    await openStatus();
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
    await openUpload();
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
    await openStatus();
    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/source/i);
    expect(message.textContent).not.toContain('IMAGE_SOURCE_UNAVAILABLE');
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry unfinished pictures' }).at(-1)!);
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
    await openUpload();
    const action = await screen.findByRole('button', {
      name: 'Add from existing image sources'
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
    await openUpload();
    fireEvent.click(await screen.findByRole('button', { name: 'Add from existing image sources' }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
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
    expect(await screen.findByText(/Image uploads are not enabled/)).toBeTruthy();
    await openSurface('Prepare images');
    expect(screen.getByText(/ordinary pictures without special names/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Analyze and upload' })).toBeNull();
    expect(client.beginImport).not.toHaveBeenCalled();
  });

  it('does not publish on drop; one explicit action admits and uploads normal pictures', async () => {
    const client = fixture();
    mount(client);
    await openUpload();
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
    closeSurface();
    await openStatus();
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
    await openStatus();
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
    await openUpload();
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

function managementEntries(count: number): CatalogImageLibraryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `stored-${String(index).padStart(4, '0')}`,
    publicationId: `publication-${index}`,
    publicUrl: `https://media.example/managed-${index}`,
    classification: classifyCatalogImageName(
      index === count - 1 ? 'hoodie_white_001.png' : 'hoodie_black_001.png'
    ),
    revision: 1,
    sizeBytes: 1000,
    active: true,
    inUse: index === 0,
    publicationState: 'ready'
  }));
}
function libraryPage(
  items: CatalogImageLibraryEntry[],
  total = items.length,
  nextCursor: string | null = null
) {
  return { items, total, revision: 1, hasMore: nextCursor !== null, nextCursor };
}

it('manages 400 images with full search, explicit shown selection and cancellable deletion', async () => {
  const client = fixture();
  const entries = managementEntries(400);
  vi.mocked(client.readLibrary).mockImplementation(async (_team, cursor) => {
    const start = cursor ? Number(cursor) : 0;
    return libraryPage(
      entries.slice(start, start + 100),
      400,
      start < 300 ? String(start + 100) : null
    );
  });
  vi.mocked(client.readStorage).mockResolvedValue({
    ...emptyStorage(),
    usedBytes: 400_000,
    availableBytes: 99_600_000,
    totalImages: 400
  });
  mount(client);
  expect(await screen.findByText('Used: 400 KB')).toBeTruthy();
  expect(screen.getAllByText('Free: 99.6 MB').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Manage images' }));
  await screen.findByText('All 400 images are available for search.');
  expect(client.readLibrary).toHaveBeenCalledWith(TEAM, '300');
  const manager = within(screen.getByRole('dialog', { name: 'Picture storage' }));
  const search = manager.getByRole('textbox', { name: 'Search stored images' });
  fireEvent.change(search, { target: { value: 'white' } });
  expect(manager.getByText('Found 1 among 400 loaded of 400 images')).toBeTruthy();
  expect(manager.getByRole('img', { name: 'Hoodie / white' }).getAttribute('src')).toBe(
    entries[399]!.publicUrl
  );
  fireEvent.change(search, { target: { value: '' } });
  fireEvent.click(manager.getByRole('checkbox', { name: 'Select shown (24)' }));
  expect(manager.getByText('24 selected · 24 KB')).toBeTruthy();
  expect(manager.queryByText('400 selected · 400 KB')).toBeNull();
  fireEvent.click(manager.getByRole('button', { name: 'Next page' }));
  expect(manager.getByText('24 selected · 24 KB')).toBeTruthy();
  expect(
    (manager.getByRole('checkbox', { name: 'Select shown (24)' }) as HTMLInputElement).checked
  ).toBe(false);
  fireEvent.click(manager.getByRole('button', { name: 'Delete selected images (24)' }));
  const confirmation = within(screen.getByRole('dialog', { name: 'Delete selected images?' }));
  expect(confirmation.getByText('Images used by existing catalogs: 1')).toBeTruthy();
  expect(confirmation.getByText(/Space will be freed once deletion finishes/)).toBeTruthy();
  expect(client.revoke).not.toHaveBeenCalled();
  fireEvent.click(confirmation.getByRole('button', { name: 'Cancel' }));
  expect(client.revoke).not.toHaveBeenCalled();
  expect(client.remove).not.toHaveBeenCalled();
  expect(manager.getByText('24 selected · 24 KB')).toBeTruthy();
});

it('stops a sequential batch after an unconfirmed deletion and retains charged storage', async () => {
  const client = fixture();
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const entries = managementEntries(3);
  vi.mocked(client.readLibrary).mockResolvedValue(libraryPage(entries));
  vi.mocked(client.readStorage).mockResolvedValue({
    ...emptyStorage(),
    usedBytes: 3000,
    availableBytes: 99_997_000,
    totalImages: 3
  });
  let acceptFirst!: (value: Awaited<ReturnType<CatalogImageClient['revoke']>>) => void;
  vi.mocked(client.revoke)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          acceptFirst = resolve;
        })
    )
    .mockRejectedValueOnce(new TeamApiError('IMAGE_WRITE_UNCERTAIN', true));
  mount(client);
  await screen.findByText('Used: 3 KB');
  fireEvent.click(screen.getByRole('button', { name: 'Manage images' }));
  await screen.findByText('All 3 images are available for search.');
  const manager = within(screen.getByRole('dialog', { name: 'Picture storage' }));
  fireEvent.click(manager.getByRole('checkbox', { name: 'Select shown (3)' }));
  fireEvent.click(manager.getByRole('button', { name: 'Delete selected images (3)' }));
  const confirmation = within(screen.getByRole('dialog', { name: 'Delete selected images?' }));
  fireEvent.click(confirmation.getByRole('button', { name: 'Delete stored images' }));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(1));
  expect(client.revoke).toHaveBeenNthCalledWith(1, entries[0]!.publicationId, {
    revision: 1,
    idempotencyKey: expect.any(String)
  });
  await act(async () =>
    acceptFirst({ items: [], total: 0, revision: 2, hasMore: false, nextCursor: null })
  );
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(2));
  expect(client.revoke).toHaveBeenNthCalledWith(2, entries[1]!.publicationId, {
    revision: 1,
    idempotencyKey: expect.any(String)
  });
  expect(
    await manager.findByText(
      'Requested: 3. Accepted: 1. Failed or unconfirmed: 1. Not attempted: 1.'
    )
  ).toBeTruthy();
  expect(manager.getByText(/Stopped at the first unconfirmed result/)).toBeTruthy();
  expect(client.revoke).not.toHaveBeenCalledWith(entries[2]!.publicationId, expect.anything());
  await waitFor(() => expect(client.readStorage).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Used: 3 KB')).toBeTruthy();
  expect(manager.getByText('3 KB used · 100 MB free · 100 MB total')).toBeTruthy();
  expect(manager.getByText(/Shared storage across the owner’s spaces\. · 3\/500/)).toBeTruthy();
  expect(client.remove).not.toHaveBeenCalled();
  const aggregate = track.mock.calls.filter(([, input]) =>
    String((input as Record<string, unknown>).action_identifier).startsWith('batch_')
  );
  expect(aggregate.map(([event]) => event)).toEqual([
    'operation_started',
    'operation_stage_completed',
    'operation_completed'
  ]);
  expect(aggregate.map(([, input]) => (input as Record<string, unknown>).file_count)).toEqual([
    3, 1, 1
  ]);
  expect(aggregate.at(-1)?.[1]).toMatchObject({
    action_identifier: 'batch_revoke_result_visible',
    outcome: 'failure'
  });
});

it('does not expose manager or batch mutation controls to a viewer', async () => {
  const client = fixture();
  vi.mocked(client.capabilities).mockResolvedValue({
    enabled: true,
    importEnabled: true,
    canManage: false,
    contractVersion: 2,
    mode: 'v2'
  });
  mount(client);
  await screen.findByText('Used: 0 B');
  expect(screen.getAllByText('Free: 100 MB').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'Manage images' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add images' })).toBeNull();
  await openSurface('Picture storage');
  expect(screen.queryByRole('checkbox', { name: /Select shown/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Delete selected/ })).toBeNull();
  expect(client.readLibrary).not.toHaveBeenCalled();
  expect(client.revoke).not.toHaveBeenCalled();
  expect(client.remove).not.toHaveBeenCalled();
});

it('delivers a visible diagnostic receipt for every accepted batch item after React commits', async () => {
  const client = fixture();
  const entries = managementEntries(3);
  vi.mocked(client.readLibrary).mockResolvedValue(libraryPage(entries));
  const remaining = [...entries];
  const page = () => ({
    items: [...remaining],
    total: remaining.length,
    revision: 4 - remaining.length,
    hasMore: false,
    nextCursor: null
  });
  vi.mocked(client.dictionary).mockImplementation(async () => page());
  vi.mocked(client.revoke).mockImplementation(async publicationId => {
    remaining.splice(
      remaining.findIndex(entry => entry.publicationId === publicationId),
      1
    );
    return page();
  });
  const observed: Array<{ name: string; properties: Record<string, unknown> }> = [];
  vi.spyOn(analytics, 'track').mockImplementation((name, input) => {
    const properties = input as Record<string, unknown>;
    if (properties.flow_step === 'catalog_image_pool') {
      if (name === 'operation_completed' && properties.run_id) {
        const removed = entries.find(entry => entry.publicationId === properties.run_id)!;
        const gallery = document.querySelector('.catalog-image-gallery');
        expect(gallery?.querySelector(`a[href="${removed.publicUrl}"]`) ?? null).toBeNull();
      }
      if (properties.action_identifier === 'batch_revoke_result_visible') {
        expect(
          screen.getByText('Requested: 3. Accepted: 3. Failed or unconfirmed: 0. Not attempted: 0.')
        ).toBeTruthy();
      }
      observed.push({ name, properties });
    }
  });
  mount(client);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage images' }));
  await screen.findByText('All 3 images are available for search.');
  const manager = within(screen.getByRole('dialog', { name: 'Picture storage' }));
  fireEvent.click(manager.getByRole('checkbox', { name: 'Select shown (3)' }));
  fireEvent.click(manager.getByRole('button', { name: 'Delete selected images (3)' }));
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Delete selected images?' })).getByRole('button', {
      name: 'Delete stored images'
    })
  );
  await waitFor(() =>
    expect(
      observed.filter(event => event.name === 'operation_completed' && event.properties.run_id)
    ).toHaveLength(3)
  );
  const aggregate = observed.filter(event =>
    String(event.properties.action_identifier).startsWith('batch_')
  );
  expect(aggregate.map(event => event.name)).toEqual([
    'operation_started',
    'operation_stage_completed',
    'operation_completed'
  ]);
  expect(aggregate.map(event => event.properties.action_identifier)).toEqual([
    'batch_revoke_requested',
    'batch_revoke_accepted',
    'batch_revoke_result_visible'
  ]);
  expect(aggregate.map(event => event.properties.file_count)).toEqual([3, 3, 3]);
  expect(aggregate.at(-1)?.properties.outcome).toBe('success');
  expect(aggregate.every(event => event.properties.run_id === undefined)).toBe(true);
  expect(new Set(aggregate.map(event => event.properties.flow_id)).size).toBe(1);
  expect(client.revoke).toHaveBeenCalledTimes(3);
  for (const entry of entries) {
    const events = observed.filter(event => event.properties.run_id === entry.publicationId);
    expect(events.map(event => event.name)).toEqual([
      'operation_started',
      'operation_stage_completed',
      'operation_completed'
    ]);
    expect(new Set(events.map(event => event.properties.flow_id)).size).toBe(1);
  }
  expect(JSON.stringify(observed)).not.toMatch(/media\.example|hoodie|https:/);
});
