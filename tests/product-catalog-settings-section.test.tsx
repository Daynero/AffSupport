// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { ProductCatalogSettings, TeamContextSnapshot } from '../apps/web/src/api/team';

/**
 * Feature 022, US2: the four values a space's catalogs are filled from, as a person meets them —
 * a manager who fills them in, a member who can only read them, and a price typed the way the
 * owner said not to.
 */

const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { ProductCatalogSettingsSection } =
  await import('../apps/web/src/team/product-catalog/ProductCatalogSettingsSection');
type Client = Parameters<typeof ProductCatalogSettingsSection>[0]['client'];

const TEAM_ID = '22000000-0000-4000-8000-0000000000aa';

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

const stored: ProductCatalogSettings = {
  title: 'Polo',
  description: 'Knit',
  price: 25,
  imageLink: 'https://drive.google.com/file/d/img/view?usp=sharing',
  updatedAt: '2026-09-15T00:00:00.000Z'
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

function renderSection(client: Client, team: TeamContextSnapshot = owned) {
  return render(
    <TeamProvider initialTeams={[team]} realtime={false}>
      <ToastProvider>
        <ProductCatalogSettingsSection teamId={TEAM_ID} client={client} />
      </ToastProvider>
    </TeamProvider>
  );
}

describe('a space’s catalog settings', () => {
  it('says they are not set, and saves what a manager fills in', async () => {
    const set = vi
      .fn()
      .mockImplementation(async (_team: string, input: Record<string, unknown>) => ({
        ...stored,
        ...input
      }));
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(null),
      setProductCatalogSettings: set
    });
    expect(await screen.findByText('Not set')).toBeTruthy();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Title'), '  Polo shirt ');
    await user.type(screen.getByLabelText('Description'), 'Lightweight knit');
    await user.type(screen.getByLabelText('Price, USD'), '10');
    await user.type(screen.getByLabelText('Image link'), 'https://img.example.test/a.png');
    expect(screen.getByText('A whole number. In the sheet: 10,00 USD')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith(TEAM_ID, {
      title: 'Polo shirt',
      description: 'Lightweight knit',
      price: 10,
      imageLink: 'https://img.example.test/a.png'
    });
    expect(await screen.findByText('Catalog settings saved')).toBeTruthy();
  });

  it.each(['10.5', '10,00', 'USD 10', '0'])(
    'refuses the price %j without sending it',
    async price => {
      const set = vi.fn();
      renderSection({
        getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
        setProductCatalogSettings: set
      });
      const user = userEvent.setup();
      const field = await screen.findByDisplayValue('25');
      await user.clear(field);
      await user.type(field, price);
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(
        await screen.findByText('A whole number from 1 to 999999, without currency.')
      ).toBeTruthy();
      expect(set).not.toHaveBeenCalled();
    }
  );

  it('refuses an image link that is not a web link', async () => {
    const set = vi.fn();
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
      setProductCatalogSettings: set
    });
    const user = userEvent.setup();
    const field = await screen.findByDisplayValue(stored.imageLink);
    await user.clear(field);
    await user.type(field, 'ftp://img.example.test/a.png');
    await user.tab();
    expect(
      await screen.findByText('Paste a link that starts with http:// or https://.')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(set).not.toHaveBeenCalled();
  });

  it('shows the saved values read-only to a member who does not manage the space', async () => {
    renderSection(
      {
        getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
        setProductCatalogSettings: vi.fn()
      },
      viewing
    );
    expect(await screen.findByText('Only a space manager can change these.')).toBeTruthy();
    const title = (await screen.findByDisplayValue('Polo')) as HTMLInputElement;
    expect(title.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('25,00 USD')).toBeTruthy();
  });
});
