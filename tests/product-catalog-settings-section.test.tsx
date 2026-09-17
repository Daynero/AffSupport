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
  title: null,
  description: null,
  price: 9,
  priceMin: 9,
  priceMax: 30,
  imageLink: null,
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

describe('a space’s catalog price and fallbacks (024)', () => {
  it('starts at 9–30 and saves a range with no single values', async () => {
    const set = vi.fn().mockResolvedValue(stored);
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(null),
      setProductCatalogSettings: set
    });
    expect(((await screen.findByLabelText('From')) as HTMLInputElement).value).toBe('9');
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('30');
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(TEAM_ID, {
        title: null,
        description: null,
        imageLink: null,
        priceMin: 9,
        priceMax: 30
      })
    );
  });

  it('will not save a range that runs backwards', async () => {
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
      setProductCatalogSettings: vi.fn()
    });
    const user = userEvent.setup();
    const from = await screen.findByLabelText('From');
    await user.clear(from);
    await user.type(from, '40');
    expect(screen.getByText('Whole dollars, and "from" no higher than "to".')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('reads, and does not offer to save, for a member who does not manage the space', async () => {
    renderSection(
      {
        getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
        setProductCatalogSettings: vi.fn()
      },
      viewing
    );
    await screen.findByLabelText('From');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('the name and description pool (024)', () => {
  it('generates the number asked for, says it is clothing only, and lists them', async () => {
    const texts: Array<{ id: string; title: string; description: string }> = [];
    const replace = vi.fn(
      async (_team: string, items: Array<{ title: string; description: string }>) => {
        texts.splice(
          0,
          texts.length,
          ...items.map((item, index) => ({ id: `t${index}`, ...item }))
        );
        return items.length;
      }
    );
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
      setProductCatalogSettings: vi.fn(),
      listProductCatalogTexts: vi.fn(async () => [...texts]),
      replaceProductCatalogTexts: replace,
      updateProductCatalogText: vi.fn()
    });
    expect(await screen.findByText(/for clothing only/)).toBeTruthy();
    const user = userEvent.setup();
    const count = screen.getByLabelText('How many');
    await user.clear(count);
    await user.type(count, '3');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls[0]![1]).toHaveLength(3);
    expect(await screen.findByText('3 in the pool')).toBeTruthy();
    // A pool that exists is replaced only after saying so.
    await user.click(screen.getByRole('button', { name: 'Generate again' }));
    expect(await screen.findByText('Replace the pool?')).toBeTruthy();
  });
});

describe('the picture pool (024)', () => {
  it('lists images and folders with how many pictures they hold, and removes one', async () => {
    const setSources = vi.fn(async () => undefined);
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
      setProductCatalogSettings: vi.fn(),
      listProductCatalogImageSources: vi.fn(async () => ({
        sources: [
          { materialId: 'f1', kind: 'folder' as const, name: 'White shirts', imageCount: 12 },
          { materialId: 'i1', kind: 'file' as const, name: 'plain.png', imageCount: 1 }
        ],
        poolSize: 13
      })),
      setProductCatalogImageSources: setSources
    });
    expect(await screen.findByText('13 pictures')).toBeTruthy();
    expect(screen.getByText('12 images')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove plain.png from the pictures' }));
    await waitFor(() =>
      expect(setSources).toHaveBeenCalledWith(TEAM_ID, [{ materialId: 'f1', kind: 'folder' }])
    );
  });
});
