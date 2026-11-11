// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { catalogForegroundPreparationFailure } from '../apps/web/src/api/catalog-video-foreground';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type {
  ProductCatalogCreateResult,
  ProductCatalogSettings,
  ProductCatalogSummary,
  TeamContextSnapshot
} from '../apps/web/src/api/team';

/**
 * Feature 022, US1 and US5: the dialog behind "Create catalog" — what it refuses before sending,
 * what it says when the space is not set up, and what it shows once there is a sheet.
 */

const { AuthContextOverride } = await import('../apps/web/src/auth/AuthContext');
const { catalogDurationPreferenceKey } =
  await import('../apps/web/src/team/product-catalog/duration-preference');
let preferenceUserId = 'catalog-user-a';
const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { TeamApiError } = await import('../apps/web/src/api/team');
const { CreateProductCatalogDialog } =
  await import('../apps/web/src/team/product-catalog/CreateProductCatalogDialog');
const { ProductCatalogMenuDialog } =
  await import('../apps/web/src/team/product-catalog/ProductCatalogMenuDialog');
type DialogClient = Parameters<typeof CreateProductCatalogDialog>[0]['client'];
type ListClient = NonNullable<Parameters<typeof ProductCatalogMenuDialog>[0]['client']>;

const TEAM_ID = '22000000-0000-4000-8000-0000000000bb';
const VIDEO = { id: '22000000-0000-4000-8000-0000000000cc', name: 'clip.mp4' };

const owned: TeamContextSnapshot = {
  id: TEAM_ID,
  name: 'Creatives',
  role: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'connected'
};
const viewing: TeamContextSnapshot = {
  ...owned,
  role: 'viewer',
  permissions: DEFAULT_ROLE_PERMISSIONS.viewer
};

const settings: ProductCatalogSettings = {
  title: 'Polo',
  description: 'Knit',
  price: 10,
  imageLink: 'https://img.example.test/a.png',
  updatedAt: '2026-09-15T00:00:00.000Z'
};

const catalog: ProductCatalogSummary = {
  id: '22000000-0000-4000-8000-0000000000dd',
  name: 'clip catalog',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet/edit',
  sourceLink: 'https://offer.example.test/?sub=1',
  productCount: 100,
  variant: 1,
  createdAt: '2026-09-15T00:00:00.000Z'
};

const created: ProductCatalogCreateResult = {
  outcome: 'created',
  catalog: {
    materialId: catalog.id,
    name: catalog.name,
    sheetUrl: catalog.sheetUrl,
    sourceLink: catalog.sourceLink,
    productCount: catalog.productCount,
    createdAt: null
  },
  videoShared: true
};

const restitchDefaults = {
  operation: 'restitch' as const,
  startImageIds: [],
  endImageIds: ['screen-1'],
  fitMode: 'cover' as const,
  finalDurationMode: 'random-40-50' as const,
  customFinalDurationSeconds: 45 * 60,
  configured: true,
  updatedAt: '2026-09-15T00:00:00.000Z',
  updatedBy: null
};

beforeEach(() => {
  preferenceUserId = 'catalog-user-a';
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function wrap(children: React.ReactNode, team: TeamContextSnapshot = owned) {
  return (
    <AuthContextOverride value={{ user: { id: preferenceUserId } }}>
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>{children}</ToastProvider>
      </TeamProvider>
    </AuthContextOverride>
  );
}

function dialogClient(overrides: Partial<DialogClient> = {}): DialogClient {
  return {
    getProductCatalogSettings: vi.fn().mockResolvedValue(settings),
    createProductCatalog: vi.fn().mockResolvedValue(created),
    ...overrides
  };
}

function renderDialog(
  client: DialogClient,
  props: {
    replaces?: ProductCatalogSummary | null;
    team?: TeamContextSnapshot;
    video?: typeof VIDEO & { parentFolderId?: string | null };
  } = {}
) {
  const onClose = vi.fn();
  render(
    wrap(
      <CreateProductCatalogDialog
        teamId={TEAM_ID}
        video={props.video ?? VIDEO}
        replaces={props.replaces}
        client={client}
        onClose={onClose}
      />,
      props.team
    )
  );
  return { onClose };
}

const confirm = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;

describe('creating a catalog', () => {
  it('always enables link variation without showing a choice', async () => {
    const client = dialogClient();
    renderDialog(client);
    const user = userEvent.setup();
    expect(screen.queryByRole('checkbox', { name: 'Random link variation' })).toBeNull();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test/');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    await waitFor(() =>
      expect(client.createProductCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ randomLinkVariation: true })
      )
    );
  });
  it('re-stitches with the chosen duration before sending the catalog creation request', async () => {
    const sourceGrant = { ticket: 'source' } as never;
    const finalizeGrant = { ticket: 'finalize' } as never;
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      canRestitch: vi.fn().mockResolvedValue('yes'),
      ensureRestitchImages: vi.fn().mockResolvedValue(undefined),
      ensureRestitchedFolder: vi.fn().mockResolvedValue({
        folderId: 'cache-drive-folder',
        materialId: 'cache-material-id'
      }),
      startProcess: vi.fn().mockResolvedValue({
        operationId: 'restitch-op',
        sourceGrant,
        finalizeGrant
      }),
      runAgentProcess: vi.fn().mockResolvedValue({
        operationId: 'restitch-op',
        state: 'succeeded',
        materialId: 'copy-id',
        reused: false
      })
    });
    renderDialog(client, { video: { ...VIDEO, parentFolderId: 'source-drive-folder' } });
    const user = userEvent.setup();
    const checkbox = screen.getByRole('checkbox', { name: 'Re-stitch video' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.queryByRole('button', { name: 'Random 30–40 minutes' })).toBeNull();
    await user.click(checkbox);
    const bounds = await screen.findAllByRole('slider');
    fireEvent.keyDown(bounds[0], { key: 'PageDown' });
    fireEvent.keyDown(bounds[0], { key: 'PageDown' });
    fireEvent.keyDown(bounds[1], { key: 'PageDown' });
    fireEvent.keyDown(bounds[1], { key: 'PageDown' });
    expect(screen.getByText('30–40 min')).toBeTruthy();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    expect(await screen.findByText('The catalog is ready')).toBeTruthy();
    expect(client.ensureRestitchedFolder).toHaveBeenCalledWith(TEAM_ID);
    expect(client.startProcess).toHaveBeenCalledWith(
      expect.objectContaining({ destinationFolderId: 'cache-material-id' })
    );
    expect(client.runAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'restitch',
        options: expect.objectContaining({
          defaults: expect.objectContaining({ finalDurationMode: 'custom' })
        })
      })
    );
    const frozenSeconds =
      client.runAgentProcess.mock.calls[0][0].options.defaults.customFinalDurationSeconds;
    expect(frozenSeconds).toBeGreaterThanOrEqual(1800);
    expect(frozenSeconds).toBeLessThanOrEqual(2400);
    expect(client.createProductCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ videoMaterialId: VIDEO.id, restitchOperationId: 'restitch-op' })
    );
    expect(vi.mocked(client.runAgentProcess!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.createProductCatalog).mock.invocationCallOrder[0]
    );
  });

  it('shows preparation immediately, observes the video percentage and waits for its receipt before creating the catalog', async () => {
    let allowStart;
    let finishVideo;
    let finishCatalog;
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      canRestitch: vi.fn(
        () =>
          new Promise(resolve => {
            allowStart = () => resolve('yes');
          })
      ),
      prepareRestitchScreens: vi.fn().mockResolvedValue({ kind: 'ready', screens: [] }),
      ensureRestitchedFolder: vi
        .fn()
        .mockResolvedValue({ folderId: 'cache', materialId: 'cache-material' }),
      startProcess: vi.fn().mockResolvedValue({
        operationId: 'observed-restitch',
        sourceGrant: { ticket: 'synthetic-source' },
        finalizeGrant: { ticket: 'synthetic-finalize' }
      }),
      runAgentProcess: vi.fn(
        () =>
          new Promise(resolve => {
            finishVideo = resolve;
          })
      ),
      getOperation: vi.fn().mockResolvedValue({
        id: 'observed-restitch',
        teamId: TEAM_ID,
        kind: 'process',
        state: 'running',
        stage: 'processing',
        progress: 42,
        sourceMaterialId: VIDEO.id,
        resultMaterialId: null,
        errorCode: null,
        retryable: false,
        createdAt: '2026-10-25T00:00:00Z',
        updatedAt: '2026-10-25T00:00:01Z'
      }),
      createProductCatalog: vi.fn(
        () =>
          new Promise(resolve => {
            finishCatalog = resolve;
          })
      )
    });
    renderDialog(client);
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await screen.findAllByRole('slider');
    await user.type(
      screen.getByLabelText(/^Link(?: · Required)?$/),
      'https://example.invalid/progress'
    );
    await user.click(confirm());
    const label = 'Video re-stitching progress';
    expect(
      screen.getByRole('progressbar', { name: label }).getAttribute('aria-valuenow')
    ).toBeNull();
    expect(client.createProductCatalog).not.toHaveBeenCalled();
    await act(async () => {
      allowStart();
    });
    await waitFor(() =>
      expect(screen.getByRole('progressbar', { name: label }).getAttribute('aria-valuenow')).toBe(
        '42'
      )
    );
    expect(client.getOperation).toHaveBeenCalledWith(TEAM_ID, 'observed-restitch');
    expect(client.createProductCatalog).not.toHaveBeenCalled();
    await act(async () => {
      finishVideo({
        operationId: 'observed-restitch',
        state: 'succeeded',
        materialId: 'finished-video',
        reused: false
      });
    });
    await waitFor(() => expect(client.createProductCatalog).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('progressbar', { name: label })).toBeNull();
    expect(screen.queryByText('42%')).toBeNull();
    await act(async () => {
      finishCatalog(created);
    });
    expect(await screen.findByText('The catalog is ready')).toBeTruthy();
  });

  it('does not write a copy beside the original when the cache folder cannot be resolved', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      canRestitch: vi.fn().mockResolvedValue('yes'),
      ensureRestitchImages: vi.fn().mockResolvedValue(undefined),
      ensureRestitchedFolder: vi.fn().mockRejectedValue(new Error('CACHE_UNAVAILABLE')),
      startProcess: vi.fn()
    });
    renderDialog(client, { video: { ...VIDEO, parentFolderId: 'source-drive-folder' } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await screen.findAllByRole('slider');
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    await waitFor(() => expect(client.ensureRestitchedFolder).toHaveBeenCalledWith(TEAM_ID));
    expect(client.startProcess).not.toHaveBeenCalled();
    expect(client.createProductCatalog).not.toHaveBeenCalled();
  });

  it('keeps exact duration within the shared 1–60 minute scale without starting a job', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      canRestitch: vi.fn().mockResolvedValue('yes'),
      startProcess: vi.fn()
    });
    renderDialog(client);
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await user.click(await screen.findByRole('button', { name: 'Exact' }));
    const minutes = screen.getByRole('slider', { name: 'Duration, minutes' });
    fireEvent.keyDown(minutes, { key: 'Home' });
    fireEvent.keyDown(minutes, { key: 'ArrowLeft' });
    expect(minutes.getAttribute('aria-valuenow')).toBe('1');
    fireEvent.keyDown(minutes, { key: 'End' });
    fireEvent.keyDown(minutes, { key: 'ArrowRight' });
    expect(minutes.getAttribute('aria-valuenow')).toBe('60');
    expect(confirm().disabled).toBe(true);
    expect(client.startProcess).not.toHaveBeenCalled();
  });

  it('reuses loaded defaults through eight toggle cycles without requests or a loading gap', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults)
    });
    const user = userEvent.setup();
    renderDialog(client);
    const toggle = screen.getByRole('checkbox', { name: 'Re-stitch video' });
    await user.click(toggle);
    await screen.findAllByRole('slider');
    for (let cycle = 0; cycle < 8; cycle += 1) {
      await user.click(toggle);
      await user.click(toggle);
      expect(screen.getAllByRole('slider')).toHaveLength(2);
    }
    expect(client.getRestitchDefaults).toHaveBeenCalledTimes(1);
    expect(client.createProductCatalog).not.toHaveBeenCalled();
  });

  it('keeps one pending defaults read through rapid toggle cycles', async () => {
    let finish;
    const pending = new Promise(resolve => {
      finish = resolve;
    });
    const client = dialogClient({ getRestitchDefaults: vi.fn().mockReturnValue(pending) });
    const user = userEvent.setup();
    renderDialog(client);
    const toggle = screen.getByRole('checkbox', { name: 'Re-stitch video' });
    await user.click(toggle);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await user.click(toggle);
      await user.click(toggle);
    }
    expect(client.getRestitchDefaults).toHaveBeenCalledTimes(1);
    finish(restitchDefaults);
    expect(await screen.findAllByRole('slider')).toHaveLength(2);
  });

  it('shows a failed defaults read as retryable instead of claiming settings are missing', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(restitchDefaults)
    });
    const user = userEvent.setup();
    renderDialog(client);
    const toggle = screen.getByRole('checkbox', { name: 'Re-stitch video' });
    await user.click(toggle);
    expect(await screen.findByText('Could not load re-stitch settings.')).toBeTruthy();
    expect(screen.queryByText('Not set up yet')).toBeNull();
    await user.click(toggle);
    await user.click(toggle);
    expect(client.getRestitchDefaults).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Repeat' }));
    expect(await screen.findAllByRole('slider')).toHaveLength(2);
    expect(client.getRestitchDefaults).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('remembers exact time immediately across toggles and reopening, isolated by user', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults)
    });
    const user = userEvent.setup();
    renderDialog(client);
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await user.click(await screen.findByRole('button', { name: 'Exact' }));
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'Home' });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    expect((await screen.findByRole('slider')).getAttribute('aria-valuenow')).toBe('2');
    cleanup();
    client.getRestitchDefaults.mockResolvedValue({
      ...restitchDefaults,
      finalDurationMode: 'random-50-60'
    });
    renderDialog(client, { video: { ...VIDEO, name: 'another.mp4' } });
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    expect((await screen.findByRole('slider')).getAttribute('aria-valuenow')).toBe('2');
    expect(client.createProductCatalog).not.toHaveBeenCalled();
    cleanup();
    preferenceUserId = 'catalog-user-b';
    renderDialog(client);
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    expect(
      (await screen.findAllByRole('slider')).map(n => n.getAttribute('aria-valuenow'))
    ).toEqual(['50', '60']);
  });

  it('remembers both independent range bounds and the selected mode', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults)
    });
    const user = userEvent.setup();
    renderDialog(client);
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    const sliders = await screen.findAllByRole('slider');
    fireEvent.keyDown(sliders[0], { key: 'PageDown' });
    fireEvent.keyDown(sliders[1], { key: 'PageDown' });
    cleanup();
    renderDialog(client);
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    expect(
      (await screen.findAllByRole('slider')).map(n => n.getAttribute('aria-valuenow'))
    ).toEqual(['35', '45']);
    expect(screen.getByRole('button', { name: 'Exact' })).toBeTruthy();
  });

  it('keeps following space defaults until the user actually changes duration', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults)
    });
    const user = userEvent.setup();
    renderDialog(client);
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await screen.findAllByRole('slider');
    expect(
      localStorage.getItem(catalogDurationPreferenceKey(preferenceUserId, TEAM_ID))
    ).toBeNull();
    cleanup();
    client.getRestitchDefaults.mockResolvedValue({
      ...restitchDefaults,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 17 * 60
    });
    renderDialog(client);
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    expect((await screen.findByRole('slider')).getAttribute('aria-valuenow')).toBe('17');
  });

  it('shows the name the catalog will have, with a copy, before it is made (024)', async () => {
    userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderDialog(dialogClient({ nextProductCatalogVariant: vi.fn().mockResolvedValue(2) }));
    expect(await screen.findByText('clip_v2_catalog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the name clip_v2_catalog' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('clip_v2_catalog'));
  });

  it('opens with the count at 100 and confirm waiting for a link', async () => {
    renderDialog(dialogClient());
    expect(
      (screen.getByRole('textbox', { name: /^Products(?: · Required)?$/ }) as HTMLInputElement)
        .value
    ).toBe('100');
    await waitFor(() => expect(confirm().disabled).toBe(true));
  });

  it.each(['0', '401', ''])('keeps confirm unavailable for the count %j', async value => {
    renderDialog(dialogClient());
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/^Link(?: · Required)?$/),
      'https://offer.example.test/?a=1'
    );
    const count = screen.getByRole('textbox', { name: /^Products(?: · Required)?$/ });
    await user.clear(count);
    if (value) await user.type(count, value);
    await user.tab();
    expect(confirm().disabled).toBe(true);
    expect(screen.getByText('A whole number from 1 to 400.')).toBeTruthy();
  });

  it('does not let a fourth digit or a letter into the count', () => {
    renderDialog(dialogClient());
    const count = screen.getByRole('textbox', {
      name: /^Products(?: · Required)?$/
    }) as HTMLInputElement;
    // A change event rather than typed keys: what is asserted is the field's own filter, and
    // simulated typing into a controlled field races under load.
    fireEvent.change(count, { target: { value: '12345' } });
    expect(count.value).toBe('123');
    fireEvent.change(count, { target: { value: 'a7' } });
    expect(count.value).toBe('7');
  });

  it('takes a link as pasted, adding https where it is missing (024)', async () => {
    const client = dialogClient();
    renderDialog(client);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'offer.example.test/?sub=1');
    await user.tab();
    expect(screen.queryByText(/Paste a link/)).toBeNull();
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    await waitFor(() =>
      expect(client.createProductCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ sourceLink: 'https://offer.example.test/?sub=1' })
      )
    );
  });

  it('sends one request with the values typed, and shows the sheet', async () => {
    const client = dialogClient();
    renderDialog(client);
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/^Link(?: · Required)?$/),
      ' https://offer.example.test/?a=1 '
    );
    const count = screen.getByRole('textbox', { name: /^Products(?: · Required)?$/ });
    await user.clear(count);
    await user.type(count, '3');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    // userEvent brings its own clipboard; the spy goes on that one.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.dblClick(confirm());

    expect(await screen.findByText('The catalog is ready')).toBeTruthy();
    expect(client.createProductCatalog).toHaveBeenCalledTimes(1);
    expect(client.createProductCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM_ID,
        videoMaterialId: VIDEO.id,
        sourceLink: 'https://offer.example.test/?a=1',
        productCount: 3,
        replacesMaterialId: null,
        idempotencyKey: expect.stringMatching(/^product-catalog:/u)
      })
    );
    const open = screen.getByRole('link', { name: 'Open catalog' }) as HTMLAnchorElement;
    expect(open.href).toBe(catalog.sheetUrl);
    await user.click(screen.getByRole('button', { name: 'Copy catalog link' }));
    expect(writeText).toHaveBeenCalledWith(catalog.sheetUrl);
  });

  it('names a passed delayed-publication time instead of the generic invalid-data error', async () => {
    const createProductCatalogVideo = vi.fn();
    const client = dialogClient({ createProductCatalogVideo } as Partial<DialogClient>);
    renderDialog(client);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test/');
    // The switch fills "now + 1 hour"; the dialog then stays open past that time.
    await user.click(screen.getByRole('switch', { name: 'Schedule the video link' }));
    const later = Date.now() + 3 * 60 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());

    expect(
      await screen.findByText(
        'The video-link time has already passed. Choose a future date and time or turn the delay off.'
      )
    ).toBeTruthy();
    expect(screen.queryByText(/Some of the data is invalid/u)).toBeNull();
    expect(createProductCatalogVideo).not.toHaveBeenCalled();
  });

  it('labels the repeated-time choice and shows its placeholder instead of a blank select', async () => {
    renderDialog(dialogClient({ createProductCatalogVideo: vi.fn() } as Partial<DialogClient>));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Schedule the video link' }));
    expect(await screen.findByText('When local time repeats')).toBeTruthy();
    expect(screen.getAllByText('Choose if needed').length).toBeGreaterThan(0);
  });

  it('keeps provider progress unknown until the catalog reply arrives', async () => {
    let finish: (value: typeof created) => void = () => undefined;
    const client = dialogClient({
      createProductCatalog: vi.fn().mockReturnValue(
        new Promise<typeof created>(resolve => {
          finish = resolve;
        })
      )
    });
    renderDialog(client);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test/');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Creating the catalog');
    expect(status.textContent).not.toMatch(/Step|Checking|Matching/u);

    finish(created);
    expect(await screen.findByText('The catalog is ready')).toBeTruthy();
    expect(screen.queryByText(/Step \d of 5/u)).toBeNull();
  });

  it('shows the catalog that already exists as a result, not an error', async () => {
    renderDialog(
      dialogClient({
        createProductCatalog: vi.fn().mockResolvedValue({ ...created, outcome: 'existing' })
      })
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test/');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    expect(await screen.findByText('This video already has a catalog')).toBeTruthy();
  });

  it('says what went wrong in the owner’s words when Drive will not share', async () => {
    renderDialog(
      dialogClient({
        createProductCatalog: vi
          .fn()
          .mockRejectedValue(new TeamApiError('SHARE_NOT_ALLOWED', false))
      })
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test/');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    expect(
      await screen.findByText('Google Drive does not allow sharing this file by link.')
    ).toBeTruthy();
    expect(confirm().disabled).toBe(false);
  });

  it('offers the way to the catalog settings when the server says there are none', async () => {
    renderDialog(
      dialogClient({
        createProductCatalog: vi
          .fn()
          .mockRejectedValue(
            new TeamApiError('INVALID_INPUT', false, { reason: 'settings_missing' })
          )
      })
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test/');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    expect(await screen.findByText('This space has no catalog settings yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open catalog settings' })).toBeTruthy();
  });
});

describe('a space without catalog settings', () => {
  it('saves default price settings when a manager creates the first catalog', async () => {
    const setProductCatalogSettings = vi.fn().mockResolvedValue(settings);
    const client = dialogClient({
      getProductCatalogSettings: vi.fn().mockResolvedValue(null),
      setProductCatalogSettings
    });
    renderDialog(client);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test/');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    await waitFor(() => expect(setProductCatalogSettings).toHaveBeenCalledOnce());
    expect(await screen.findByText('The catalog is ready')).toBeTruthy();
  });

  it('tells a member who cannot fix it who can', async () => {
    renderDialog(dialogClient({ getProductCatalogSettings: vi.fn().mockResolvedValue(null) }), {
      team: viewing
    });
    expect(
      await screen.findByText('A space manager needs to fill in the catalog settings first.')
    ).toBeTruthy();
  });
});

describe('re-creating a catalog', () => {
  it('opens on what the catalog was made from and sends what it replaces', async () => {
    const client = dialogClient({
      createProductCatalog: vi.fn().mockResolvedValue({ ...created, outcome: 'recreated' })
    });
    renderDialog(client, { replaces: catalog });
    expect((screen.getByLabelText(/^Link(?: · Required)?$/) as HTMLInputElement).value).toBe(
      catalog.sourceLink
    );
    expect(
      (screen.getByRole('textbox', { name: /^Products(?: · Required)?$/ }) as HTMLInputElement)
        .value
    ).toBe('100');
    expect(
      screen.getByText(
        'The current catalog goes to the trash, and its link will not show the new products.'
      )
    ).toBeTruthy();
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Re-create' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await waitFor(() =>
      expect(client.createProductCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ replacesMaterialId: catalog.id })
      )
    );
  });
});

describe('a video’s catalogs (024, US15)', () => {
  const second: ProductCatalogSummary = {
    ...catalog,
    id: '22000000-0000-4000-8000-0000000000ee',
    name: 'clip_v2_catalog',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/second/edit',
    sourceLink: 'https://other.example.test/?sub=2',
    productCount: 40,
    variant: 2
  };

  function listClient(overrides: Partial<ListClient> = {}): ListClient {
    return {
      listProductCatalogs: vi.fn().mockResolvedValue([catalog, second]),
      trashMaterial: vi.fn().mockResolvedValue({
        operationId: 'op',
        state: 'succeeded',
        materialId: second.id,
        reused: false
      }),
      getProductCatalogSettings: vi.fn().mockResolvedValue(settings),
      createProductCatalog: vi.fn().mockResolvedValue({
        ...created,
        catalog: { ...created.catalog, name: 'clip_v3_catalog', variant: 3 }
      }),
      ...overrides
    };
  }

  function renderList(client: ListClient, team: TeamContextSnapshot = owned) {
    const onClose = vi.fn();
    render(
      wrap(
        <ProductCatalogMenuDialog
          teamId={TEAM_ID}
          video={VIDEO}
          client={client}
          onClose={onClose}
        />,
        team
      )
    );
    return { onClose };
  }

  it('lists every variation, and copies a name and a link in one press', async () => {
    renderList(listClient());
    expect(await screen.findByText('clip_v2_catalog')).toBeTruthy();
    expect(screen.getByText('clip catalog')).toBeTruthy();
    expect(screen.getByText('other.example.test/?sub=2')).toBeTruthy();

    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(screen.getByRole('button', { name: 'Copy the name clip_v2_catalog' }));
    expect(writeText).toHaveBeenLastCalledWith('clip_v2_catalog');
    await user.click(screen.getByRole('button', { name: 'Copy the link of clip_v2_catalog' }));
    expect(writeText).toHaveBeenLastCalledWith(second.sheetUrl);
    expect(
      (screen.getByRole('link', { name: 'Open clip_v2_catalog' }) as HTMLAnchorElement).href
    ).toBe(second.sheetUrl);
  });

  it('makes a new variation beside the others, starting from the last count, and offers its name', async () => {
    const client = listClient();
    renderList(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New variation' }));

    expect(screen.getByRole('heading', { name: 'New catalog variation' })).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: /^Products(?: · Required)?$/ }) as HTMLInputElement)
        .value
    ).toBe('40');
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://third.example.test/');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());

    expect(client.createProductCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ replacesMaterialId: null })
    );
    expect(await screen.findByText('clip_v3_catalog')).toBeTruthy();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(screen.getByRole('button', { name: 'Copy the name clip_v3_catalog' }));
    expect(writeText).toHaveBeenLastCalledWith('clip_v3_catalog');
  });

  it('re-creates one variation from its menu, sending only that one', async () => {
    const client = listClient();
    renderList(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for clip_v2_catalog' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Re-create catalog' }));
    expect((screen.getByLabelText(/^Link(?: · Required)?$/) as HTMLInputElement).value).toBe(
      second.sourceLink
    );
    const button = screen.getByRole('button', { name: 'Re-create' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await waitFor(() =>
      expect(client.createProductCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ replacesMaterialId: second.id })
      )
    );
  });

  it('removes a variation to the trash and takes it off the list at once', async () => {
    const client = listClient();
    renderList(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for clip_v2_catalog' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove variation' }));

    await waitFor(() => expect(screen.queryByText('clip_v2_catalog')).toBeNull());
    expect(client.trashMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: TEAM_ID, materialId: second.id })
    );
    expect(await screen.findByText('clip_v2_catalog moved to the trash')).toBeTruthy();
  });

  it.each([true, false])(
    'asks before deleting a variation whose video is in R2, since it cannot come back, with R2 available: %s (050)',
    async available => {
      const client = listClient();
      const videoR2Client = {
        availability: vi.fn().mockResolvedValue({
          available,
          reason: available ? null : 'VIDEO_R2_NOT_CONFIGURED',
          canManage: true,
          contractVersion: 1
        }),
        listSignals: vi.fn().mockResolvedValue([
          {
            catalogMaterialId: second.id,
            enabled: true,
            link: 'r2',
            copyState: 'ready',
            reason: null,
            lastSuccessfulUpdateAt: null,
            revision: 2
          }
        ]),
        setPreference: vi.fn()
      } as unknown as NonNullable<Parameters<typeof ProductCatalogMenuDialog>[0]['videoR2Client']>;
      render(
        wrap(
          <ProductCatalogMenuDialog
            teamId={TEAM_ID}
            video={VIDEO}
            client={client}
            videoR2Client={videoR2Client}
            onClose={vi.fn()}
          />,
          owned
        )
      );
      await waitFor(() => expect(videoR2Client.listSignals).toHaveBeenCalled());
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Actions for clip_v2_catalog' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Remove variation' }));
      expect(await screen.findByText('Delete the catalog for good?')).toBeTruthy();
      expect(client.trashMaterial).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Delete for good' }));
      await waitFor(() =>
        expect(client.trashMaterial).toHaveBeenCalledWith(
          expect.objectContaining({ teamId: TEAM_ID, materialId: second.id })
        )
      );
    }
  );

  it('closes on Done after the first catalog, instead of opening the list', async () => {
    const api = listClient({
      listProductCatalogs: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([catalog])
    });
    const { onClose } = renderList(api);
    const link = await screen.findByLabelText(/^Link(?: · Required)?$/);
    fireEvent.change(link, { target: { value: 'https://offer.example.test/' } });
    await waitFor(() => expect(confirm().disabled).toBe(false));
    fireEvent.click(confirm());
    await screen.findByText('The catalog is ready');
    const done = screen
      .getAllByRole('button', { name: 'Done' })
      .find(button => button.textContent === 'Done')!;
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalled();
  });

  it('opens straight on the form when the video has none', async () => {
    renderList(listClient({ listProductCatalogs: vi.fn().mockResolvedValue([]) }));
    expect(await screen.findByRole('heading', { name: 'Create catalog' })).toBeTruthy();
  });

  it('lets a member who cannot add files copy and open, but not make or remove', async () => {
    renderList(listClient(), viewing);
    expect(await screen.findByText('clip_v2_catalog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New variation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for clip_v2_catalog' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy the name clip_v2_catalog' })).toBeTruthy();
  });
});
// @ts-nocheck — dialog fixture keeps the historical minimal settings shape.

describe('a creation still running behind the catalogs list (1.4.3)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_APP_ENVIRONMENT', 'beta');
  });
  afterEach(() => vi.unstubAllEnvs());
  const pendingKey = 'product-catalog:47000000-0000-4000-8000-000000000021';
  const pending = {
    outcome: 'preparing_video',
    catalogIntentId: '47000000-0000-4000-8000-000000000001',
    videoSetId: '47000000-0000-4000-8000-000000000002',
    requestedCount: 5,
    registeredCount: 2,
    state: 'preparing'
  };
  function client(overrides: Partial<ListClient> = {}): ListClient {
    return {
      listProductCatalogs: vi.fn().mockResolvedValue([catalog]),
      trashMaterial: vi.fn(),
      getProductCatalogSettings: vi.fn().mockResolvedValue(settings),
      createProductCatalog: vi.fn().mockResolvedValue(created),
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn(),
      readProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      nextProductCatalogVariant: vi.fn().mockResolvedValue(3),
      ...overrides
    } as ListClient;
  }
  function renderList(listClient: ListClient) {
    render(
      wrap(
        <ProductCatalogMenuDialog
          teamId={TEAM_ID}
          video={VIDEO}
          client={listClient}
          onClose={vi.fn()}
        />
      )
    );
  }

  it('lists the running creation and opens it from there', async () => {
    localStorage.setItem(
      `soty:catalog-video-create:v1:${preferenceUserId}:${TEAM_ID}:${VIDEO.id}`,
      pendingKey
    );
    const listClient = client();
    renderList(listClient);
    expect(await screen.findByText('A catalog is being created')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show progress' }));
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
    expect(listClient.readProductCatalogVideo).toHaveBeenCalledWith(
      TEAM_ID,
      pendingKey,
      expect.anything()
    );
    // The next free number is not the running creation's name.
    expect(screen.queryByText(/_v3_catalog/)).toBeNull();
  });

  it('shows no running creation when this browser has none', async () => {
    renderList(client());
    expect(await screen.findByText(catalog.name)).toBeTruthy();
    expect(screen.queryByText('A catalog is being created')).toBeNull();
  });
});

describe('a catalog re-stitched with pictures from the space (030)', () => {
  it('carries the drawn screens to the app and speaks contract 2', async () => {
    const screens = [
      {
        slot: 'start',
        materialId: 'pic-1',
        checksum: 'a'.repeat(32),
        mimeType: 'image/png',
        fileName: 'a.png',
        sizeBytes: 10,
        transfer: { transferUrl: 'https://edge.test/range', grant: { ticket: 't' } }
      }
    ];
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue({ ...restitchDefaults, sourceMode: 'drive' }),
      canRestitch: vi.fn().mockResolvedValue('yes'),
      ensureRestitchImages: vi.fn().mockResolvedValue(undefined),
      prepareRestitchScreens: vi.fn().mockResolvedValue({ kind: 'ready', screens }),
      ensureRestitchedFolder: vi.fn().mockResolvedValue({
        folderId: 'cache-drive-folder',
        materialId: 'cache-material-id'
      }),
      startProcess: vi.fn().mockResolvedValue({
        operationId: 'restitch-op',
        sourceGrant: { ticket: 'source' },
        finalizeGrant: { ticket: 'finalize' }
      }),
      runAgentProcess: vi.fn().mockResolvedValue({
        operationId: 'restitch-op',
        state: 'succeeded',
        materialId: 'copy-id',
        reused: false
      })
    });
    renderDialog(client, { video: { ...VIDEO, parentFolderId: 'source-drive-folder' } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await screen.findAllByRole('slider');
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    expect(await screen.findByText('The catalog is ready')).toBeTruthy();
    expect(client.prepareRestitchScreens).toHaveBeenCalledWith(
      TEAM_ID,
      expect.objectContaining({ sourceMode: 'drive' })
    );
    // The published library is never read for a space that draws from Drive.
    expect(client.ensureRestitchImages).not.toHaveBeenCalled();
    expect(client.startProcess).toHaveBeenCalledWith(
      expect.objectContaining({ toolContractVersion: 2 })
    );
    expect(client.runAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ screens, teamId: TEAM_ID })
      })
    );
  });

  it('tells a member whose app predates Drive pools to update it', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue({ ...restitchDefaults, sourceMode: 'drive' }),
      canRestitch: vi.fn().mockResolvedValue('yes'),
      prepareRestitchScreens: vi.fn().mockResolvedValue({ kind: 'too-old' }),
      runAgentProcess: vi.fn()
    });
    renderDialog(client, { video: { ...VIDEO, parentFolderId: 'source-drive-folder' } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await user.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    await waitFor(() => expect(screen.queryByText('The catalog is ready')).toBeNull());
    expect(client.runAgentProcess).not.toHaveBeenCalled();
  });
});

describe('beta durable video creation', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_APP_ENVIRONMENT', 'beta');
  });
  afterEach(() => vi.unstubAllEnvs());
  const pending = {
    outcome: 'preparing_video',
    catalogIntentId: '47000000-0000-4000-8000-000000000001',
    videoSetId: '47000000-0000-4000-8000-000000000002',
    requestedCount: 5,
    registeredCount: 2,
    state: 'preparing'
  };
  async function startVideo(client) {
    renderDialog(client);
    await userEvent.type(
      screen.getByLabelText(/^Link(?: · Required)?$/),
      'https://offer.example.test/'
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    const variations = await screen.findByLabelText('Video variations');
    await userEvent.clear(variations);
    await userEvent.type(variations, '5');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await userEvent.click(confirm());
  }
  it('shows admitted K/N without a completed catalog and cancels the original operation', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      readProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      cancelProductCatalogVideo: vi.fn().mockResolvedValue({ ...pending, state: 'canceled' })
    });
    await startVideo(client);
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
    expect(screen.queryByText('Catalog ready')).toBeNull();
    expect(client.createProductCatalog).not.toHaveBeenCalled();
    const input = client.createProductCatalogVideo.mock.calls[0][0];
    expect(input).toMatchObject({
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 5
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel video generation' }));
    expect(await screen.findByText('Catalog creation canceled.')).toBeTruthy();
    expect(client.cancelProductCatalogVideo).toHaveBeenCalledWith(
      TEAM_ID,
      input.idempotencyKey,
      expect.any(String),
      expect.any(Object)
    );
  });
  it('reopens a tracked creation with what the person submitted, not an empty form (1.4.3)', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      nextProductCatalogVariant: vi.fn().mockResolvedValue(20),
      createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      readProductCatalogVideo: vi.fn().mockResolvedValue(pending)
    });
    await startVideo(client);
    await screen.findByText('Videos ready: 2 of 5');
    expect(screen.getByText('clip_v20_catalog')).toBeTruthy();
    cleanup();
    // "Show progress" from the list; by now the next free number has moved on.
    vi.mocked(client.nextProductCatalogVariant!).mockResolvedValue(21);
    renderDialog(client);
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
    expect((screen.getByLabelText(/^Link(?: · Required)?$/) as HTMLInputElement).value).toBe(
      'https://offer.example.test/'
    );
    expect(
      (screen.getByRole('checkbox', { name: 'Re-stitch video' }) as HTMLInputElement).checked
    ).toBe(true);
    expect(((await screen.findByLabelText('Video variations')) as HTMLInputElement).value).toBe(
      '5'
    );
    expect(screen.getByText('clip_v20_catalog')).toBeTruthy();
    expect(screen.queryByText('clip_v21_catalog')).toBeNull();
  });

  it('forgets the remembered form together with the finished creation', async () => {
    const key = 'product-catalog:47000000-0000-4000-8000-000000000012';
    const storageKey = `soty:catalog-video-create:v1:${preferenceUserId}:${TEAM_ID}:${VIDEO.id}`;
    localStorage.setItem(storageKey, key);
    localStorage.setItem(
      `${storageKey}:form`,
      JSON.stringify({
        key,
        link: 'https://offer.example.test/',
        count: '5',
        restitch: false,
        copyVideoToR2: false,
        videoDraft: { variationCount: '1', delayed: false, date: '', time: '12:00', zone: 'UTC' },
        name: 'clip_v4_catalog'
      })
    );
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      readProductCatalogVideo: vi.fn().mockResolvedValue({ ...pending, state: 'canceled' })
    });
    renderDialog(client);
    await screen.findByRole('button', { name: 'Done' });
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(localStorage.getItem(`${storageKey}:form`)).toBeNull();
  });

  it('lets the person close the window while the server and the agent prepare the videos', async () => {
    // 1.4.3 (beta 2026-11-11): a 40-minute re-stitch kept the window open; the ✕
    // was labelled "Cancel" and did nothing, Escape and the backdrop neither.
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      readProductCatalogVideo: vi.fn().mockResolvedValue(pending)
    });
    const { onClose } = renderDialog(client);
    await userEvent.type(
      screen.getByLabelText(/^Link(?: · Required)?$/),
      'https://offer.example.test/'
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Re-stitch video' }));
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await userEvent.click(confirm());
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('names a computer agent that stopped answering and keeps cancellation at hand', async () => {
    // 1.4.3 (beta 2026-11-11): the agent was killed mid-run and the window
    // kept counting as if nothing had happened.
    const silent = { ...pending, agentSilent: true };
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockResolvedValue(silent),
      readProductCatalogVideo: vi.fn().mockResolvedValue(silent)
    });
    await startVideo(client);
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
    expect(screen.getByText(/Soty on the computer is not responding/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel video generation' })).toBeTruthy();
    expect(screen.queryByText(/result is not confirmed/)).toBeNull();
  });
  it('does not call a heartbeating agent silent', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      readProductCatalogVideo: vi.fn().mockResolvedValue(pending)
    });
    await startVideo(client);
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
    expect(screen.queryByText(/is not responding/)).toBeNull();
  });
  it('unlocks the original inputs after a proved missing paired executor without retaining an unknown request', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi
        .fn()
        .mockRejectedValue(new TeamApiError('AGENT_REQUIRED', false))
    });
    await startVideo(client);
    await screen.findByText(/open the latest Soty app and connect it to this browser/);
    expect(screen.getByLabelText(/^Link(?: · Required)?$/).disabled).toBe(false);
    expect(screen.getByLabelText('Video variations').disabled).toBe(false);
    expect(confirm().disabled).toBe(false);
    const originalKey = client.createProductCatalogVideo.mock.calls[0][0].idempotencyKey;
    expect(Object.values(localStorage)).not.toContain(originalKey);
    expect(client.createProductCatalogVideo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/result is not confirmed/)).toBeNull();
  });
  it('unlocks after a locally proved preparation failure without treating an unknown provider response as rejected', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi
        .fn()
        .mockRejectedValue(catalogForegroundPreparationFailure(Error('INVALID_RESPONSE')))
    });
    await startVideo(client);
    await waitFor(() => expect(confirm().disabled).toBe(false));
    expect(screen.getByLabelText('Video variations').disabled).toBe(false);
    const originalKey = client.createProductCatalogVideo.mock.calls[0][0].idempotencyKey;
    expect(Object.values(localStorage)).not.toContain(originalKey);
    expect(client.createProductCatalogVideo).toHaveBeenCalledTimes(1);
  });
  it('re-reads on its own after the server finishes the catalog in the background', async () => {
    // The agent reports the video; the server then registers the catalog from a
    // cron pass, which announces nothing. The window must notice by itself.
    let serverDone = false;
    const read = vi.fn(async () => (serverDone ? created : pending));
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      readProductCatalogVideo: read
    });
    await startVideo(client);
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
    serverDone = true;
    expect(await screen.findByText('The catalog is ready', {}, { timeout: 8_000 })).toBeTruthy();
  }, 15_000);
  it.each(['canceled', 'cancel_requested'])(
    'lets a %s creation go so the next one can start (BenGan, 1.4.2)',
    async state => {
      const key = 'product-catalog:47000000-0000-4000-8000-000000000011';
      const storageKey = `soty:catalog-video-create:v1:${preferenceUserId}:${TEAM_ID}:${VIDEO.id}`;
      localStorage.setItem(storageKey, key);
      const client = dialogClient({
        getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
        createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
        readProductCatalogVideo: vi.fn().mockResolvedValue({ ...pending, state })
      });
      renderDialog(client);
      const done = await screen.findByRole('button', { name: 'Done' });
      if (state === 'canceled') expect(localStorage.getItem(storageKey)).toBeNull();
      await userEvent.click(done);
      expect(localStorage.getItem(storageKey)).toBeNull();
      await userEvent.type(
        screen.getByLabelText(/^Link(?: · Required)?$/),
        'https://offer.example.test/'
      );
      await waitFor(() => expect(confirm().disabled).toBe(false));
      const reads = vi.mocked(client.readProductCatalogVideo!).mock.calls.length;
      cleanup();
      renderDialog(client);
      expect(await screen.findByRole('button', { name: 'Create' })).toBeTruthy();
      // Reopening shows the form; the forgotten operation is never read again.
      expect(vi.mocked(client.readProductCatalogVideo!).mock.calls.length).toBe(reads);
    }
  );
  it('does not call the result unconfirmed while the create request is still in flight', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn(
        () =>
          new Promise(resolve => {
            answer = resolve;
          })
      ),
      readProductCatalogVideo: vi.fn().mockResolvedValue(pending)
    });
    await startVideo(client);
    await waitFor(() => expect(client.createProductCatalogVideo).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/result is not confirmed/)).toBeNull();
    answer(pending);
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
  });

  it('offers one cancel action while a video creation is tracked', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      readProductCatalogVideo: vi.fn().mockResolvedValue(pending)
    });
    await startVideo(client);
    await screen.findByText('Videos ready: 2 of 5');
    // The modal's own × only closes the window; the generation's cancel is the one cancel action.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Cancel video generation' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });

  it('says a slow server is temporary when cancelling times out', async () => {
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      readProductCatalogVideo: vi.fn().mockResolvedValue(pending),
      cancelProductCatalogVideo: vi
        .fn()
        .mockRejectedValue(new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true))
    });
    await startVideo(client);
    await screen.findByText('Videos ready: 2 of 5');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel video generation' }));
    expect(await screen.findByText('The server is responding slowly. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel video generation' })).toBeTruthy();
  });

  it('recovers a lost reply on reopen through read only using the original key', async () => {
    const read = vi.fn().mockResolvedValue(pending);
    const client = dialogClient({
      getRestitchDefaults: vi.fn().mockResolvedValue(restitchDefaults),
      createProductCatalogVideo: vi.fn().mockRejectedValue(Error('PROCESS_RESULT_UNCERTAIN')),
      readProductCatalogVideo: read
    });
    await startVideo(client);
    await screen.findByText(/result is not confirmed/);
    const key = client.createProductCatalogVideo.mock.calls[0][0].idempotencyKey;
    cleanup();
    renderDialog(client);
    await waitFor(() => expect(read).toHaveBeenCalledWith(TEAM_ID, key, expect.any(Object)));
    expect(client.createProductCatalogVideo).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
  });
});

it('shows current N progress after the scheduled blank catalog was already created', async () => {
  vi.stubEnv('VITE_APP_ENVIRONMENT', 'beta');
  try {
    const setId = '47000000-0000-4000-8000-000000000002';
    const generation = {
      videoSetId: setId,
      requestedCount: 5,
      registeredCount: 0,
      state: 'preparing',
      catalogVideoCells: 'deferred_blank',
      providerCas: 'unsupported'
    };
    const observation = { ...generation, registeredCount: 2 };
    const response = {
      ...created,
      videoGeneration: generation,
      videoGenerationObservation: observation
    };
    const client = dialogClient({
      createProductCatalogVideo: vi.fn(),
      readCatalogPublication: vi.fn().mockResolvedValue({
        catalogId: catalog.id,
        revision: 1,
        mode: 'scheduled',
        dueAt: '2030-01-01T12:00:00.000Z',
        timeZone: 'UTC',
        target: { kind: 'video_set', videoSetId: setId, recipeRevision: 1 },
        job: {
          id: catalog.id,
          state: 'waiting',
          revision: 1,
          writerFence: null,
          blockedReason: null
        },
        active: null,
        serverNow: Date.parse('2029-12-31T00:00:00Z')
      }),
      readProductCatalogVideo: vi.fn().mockResolvedValue(response),
      cancelProductCatalogVideo: vi.fn().mockResolvedValue({
        ...response,
        videoGenerationObservation: { ...observation, state: 'canceled', publicationHeld: true }
      })
    });
    localStorage.setItem(
      `soty:catalog-video-create:v1:${preferenceUserId}:${TEAM_ID}:${VIDEO.id}`,
      'product-catalog:47000000-0000-4000-8000-000000000010'
    );
    renderDialog(client);
    expect(await screen.findByText('Videos ready: 2 of 5')).toBeTruthy();
    expect(screen.getByText(catalog.name)).toBeTruthy();
    expect(screen.getByText(/catalog is created with empty video fields/)).toBeTruthy();
    // 1.4.3: a restitched deferred catalog names its scheduled time too.
    expect(await screen.findByText(/Video-link publication is scheduled for/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel video generation' }));
    expect(
      await screen.findByText('Video generation canceled. The created catalog is preserved.')
    ).toBeTruthy();
    expect(screen.getByText(catalog.name)).toBeTruthy();
    expect(client.createProductCatalogVideo).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('catalog assembly once every video is ready (1.4.3)', () => {
  const key = 'product-catalog:47000000-0000-4000-8000-000000000020';
  const allReady = {
    outcome: 'preparing_video',
    catalogIntentId: '47000000-0000-4000-8000-000000000021',
    videoSetId: '47000000-0000-4000-8000-000000000022',
    requestedCount: 3,
    registeredCount: 3,
    state: 'preparing'
  };
  beforeEach(() => {
    vi.stubEnv('VITE_APP_ENVIRONMENT', 'beta');
    localStorage.setItem(
      `soty:catalog-video-create:v1:${preferenceUserId}:${TEAM_ID}:${VIDEO.id}`,
      key
    );
  });
  afterEach(() => vi.unstubAllEnvs());
  it('assembles the catalog on a plain read instead of waiting for the background pass', async () => {
    const client = dialogClient({
      createProductCatalogVideo: vi.fn(),
      readProductCatalogVideo: vi.fn().mockResolvedValue(allReady),
      resumeProductCatalogVideo: vi.fn().mockResolvedValue(allReady)
    });
    renderDialog(client);
    await waitFor(() =>
      expect(client.resumeProductCatalogVideo).toHaveBeenCalledWith(TEAM_ID, key, expect.anything())
    );
  });
  it('keeps reading quietly when another executor is already assembling it', async () => {
    const client = dialogClient({
      createProductCatalogVideo: vi.fn(),
      readProductCatalogVideo: vi.fn().mockResolvedValue(allReady),
      resumeProductCatalogVideo: vi
        .fn()
        .mockRejectedValue(new TeamApiError('GROUP_RECONCILING', true))
    });
    renderDialog(client);
    await waitFor(() => expect(client.resumeProductCatalogVideo).toHaveBeenCalled());
    expect(await screen.findByText('Videos ready: 3 of 3')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
