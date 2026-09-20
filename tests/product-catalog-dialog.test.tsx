// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { TeamApiError } = await import('../apps/web/src/api/team');
const { CreateProductCatalogDialog } =
  await import('../apps/web/src/team/product-catalog/CreateProductCatalogDialog');
const { VideoProductCatalogActions } =
  await import('../apps/web/src/team/product-catalog/VideoProductCatalogActions');
type DialogClient = Parameters<typeof CreateProductCatalogDialog>[0]['client'];
type ActionsClient = NonNullable<Parameters<typeof VideoProductCatalogActions>[0]['client']>;

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

beforeEach(() => {
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
    <TeamProvider initialTeams={[team]} realtime={false}>
      <ToastProvider>{children}</ToastProvider>
    </TeamProvider>
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
  props: { replaces?: ProductCatalogSummary | null; team?: TeamContextSnapshot } = {}
) {
  const onClose = vi.fn();
  render(
    wrap(
      <CreateProductCatalogDialog
        teamId={TEAM_ID}
        video={VIDEO}
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
  it('opens with the count at 100 and confirm waiting for a link', async () => {
    renderDialog(dialogClient());
    expect((screen.getByLabelText('Products') as HTMLInputElement).value).toBe('100');
    await waitFor(() => expect(confirm().disabled).toBe(true));
  });

  it.each(['0', '401', ''])('keeps confirm unavailable for the count %j', async value => {
    renderDialog(dialogClient());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Link'), 'https://offer.example.test/?a=1');
    const count = screen.getByLabelText('Products');
    await user.clear(count);
    if (value) await user.type(count, value);
    await user.tab();
    expect(confirm().disabled).toBe(true);
    expect(screen.getByText('A whole number from 1 to 400.')).toBeTruthy();
  });

  it('does not let a fourth digit or a letter into the count', () => {
    renderDialog(dialogClient());
    const count = screen.getByLabelText('Products') as HTMLInputElement;
    // A change event rather than typed keys: what is asserted is the field's own filter, and
    // simulated typing into a controlled field races under load.
    fireEvent.change(count, { target: { value: '12345' } });
    expect(count.value).toBe('123');
    fireEvent.change(count, { target: { value: 'a7' } });
    expect(count.value).toBe('7');
  });

  it('refuses a link that is not a web link', async () => {
    renderDialog(dialogClient());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Link'), 'ftp://offer.example.test');
    await user.tab();
    expect(screen.getByText('Paste a link that starts with http:// or https://.')).toBeTruthy();
    expect(confirm().disabled).toBe(true);
  });

  it('sends one request with the values typed, and shows the sheet', async () => {
    const client = dialogClient();
    renderDialog(client);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Link'), ' https://offer.example.test/?a=1 ');
    const count = screen.getByLabelText('Products');
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

  it('shows the catalog that already exists as a result, not an error', async () => {
    renderDialog(
      dialogClient({
        createProductCatalog: vi.fn().mockResolvedValue({ ...created, outcome: 'existing' })
      })
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Link'), 'https://offer.example.test/');
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
    await user.type(screen.getByLabelText('Link'), 'https://offer.example.test/');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    expect(
      await screen.findByText('Google Drive does not allow sharing this file by link.')
    ).toBeTruthy();
    expect(confirm().disabled).toBe(false);
  });
});

describe('a space without catalog settings', () => {
  it('points a manager at the settings and does not allow confirming', async () => {
    renderDialog(dialogClient({ getProductCatalogSettings: vi.fn().mockResolvedValue(null) }));
    expect(await screen.findByText('This space has no catalog settings yet.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open catalog settings' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('tab=product-catalog');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Link'), 'https://offer.example.test/');
    expect(confirm().disabled).toBe(true);
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
    expect((screen.getByLabelText('Link') as HTMLInputElement).value).toBe(catalog.sourceLink);
    expect((screen.getByLabelText('Products') as HTMLInputElement).value).toBe('100');
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

describe('the catalog from a row menu', () => {
  it('opens on the catalog the video has, and re-creates from there', async () => {
    const client = dialogClient({
      createProductCatalog: vi.fn().mockResolvedValue({ ...created, outcome: 'recreated' })
    });
    render(
      wrap(
        <CreateProductCatalogDialog
          teamId={TEAM_ID}
          video={VIDEO}
          existing={catalog}
          client={client}
          onClose={vi.fn()}
        />
      )
    );
    expect(screen.getByText('clip catalog')).toBeTruthy();
    expect((screen.getByRole('link', { name: 'Open catalog' }) as HTMLAnchorElement).href).toBe(
      catalog.sheetUrl
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Re-create catalog' }));
    expect((screen.getByLabelText('Link') as HTMLInputElement).value).toBe(catalog.sourceLink);
    const button = screen.getByRole('button', { name: 'Re-create' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await waitFor(() =>
      expect(client.createProductCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ replacesMaterialId: catalog.id })
      )
    );
  });

  it('opens straight on the form when the video has none', () => {
    render(
      wrap(
        <CreateProductCatalogDialog
          teamId={TEAM_ID}
          video={VIDEO}
          existing={null}
          client={dialogClient()}
          onClose={vi.fn()}
        />
      )
    );
    expect(screen.getByLabelText('Link')).toBeTruthy();
  });
});

describe('the catalog on a video’s card', () => {
  function actionsClient(overrides: Partial<ActionsClient> = {}): ActionsClient {
    return {
      getProductCatalog: vi.fn().mockResolvedValue(null),
      getProductCatalogSettings: vi.fn().mockResolvedValue(settings),
      createProductCatalog: vi.fn().mockResolvedValue(created),
      ...overrides
    };
  }

  it('offers to create one when the video has none', async () => {
    render(
      wrap(<VideoProductCatalogActions teamId={TEAM_ID} video={VIDEO} client={actionsClient()} />)
    );
    expect(await screen.findByRole('button', { name: 'Create catalog' })).toBeTruthy();
  });

  it('copies and opens the catalog the video has, and offers to re-create it', async () => {
    render(
      wrap(
        <VideoProductCatalogActions
          teamId={TEAM_ID}
          video={VIDEO}
          client={actionsClient({ getProductCatalog: vi.fn().mockResolvedValue(catalog) })}
        />
      )
    );
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(await screen.findByRole('button', { name: 'Copy catalog link' }));
    expect(writeText).toHaveBeenCalledWith(catalog.sheetUrl);
    expect((screen.getByRole('link', { name: 'Open catalog' }) as HTMLAnchorElement).href).toBe(
      catalog.sheetUrl
    );
    expect(screen.getByRole('button', { name: 'Re-create catalog' })).toBeTruthy();
  });

  it('reads the catalog again when the space’s revision moves', async () => {
    const getProductCatalog = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(catalog);
    const client = actionsClient({ getProductCatalog });
    const { rerender } = render(
      wrap(
        <VideoProductCatalogActions teamId={TEAM_ID} video={VIDEO} client={client} revision={1} />
      )
    );
    expect(await screen.findByRole('button', { name: 'Create catalog' })).toBeTruthy();
    rerender(
      wrap(
        <VideoProductCatalogActions teamId={TEAM_ID} video={VIDEO} client={client} revision={2} />
      )
    );
    expect(await screen.findByRole('button', { name: 'Copy catalog link' })).toBeTruthy();
  });

  it('does not offer to create or re-create to a member who cannot add files', async () => {
    render(
      wrap(
        <VideoProductCatalogActions
          teamId={TEAM_ID}
          video={VIDEO}
          client={actionsClient({ getProductCatalog: vi.fn().mockResolvedValue(catalog) })}
        />,
        viewing
      )
    );
    expect(await screen.findByRole('button', { name: 'Copy catalog link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Re-create catalog' })).toBeNull();
  });
});
