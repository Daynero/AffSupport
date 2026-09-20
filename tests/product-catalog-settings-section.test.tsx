// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
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

  it('offers to save only what differs from what the space holds', async () => {
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
      setProductCatalogSettings: vi.fn().mockResolvedValue(stored)
    });
    const user = userEvent.setup();
    const from = await screen.findByLabelText('From');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    );
    expect(screen.queryByText('Not saved yet')).toBeNull();
    await user.clear(from);
    await user.type(from, '5');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('Not saved yet')).toBeNull());
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

describe('whether a catalog can be made (024, US23)', () => {
  it('says what every column will draw from, and what is missing', async () => {
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue({ ...stored, imageLink: null }),
      setProductCatalogSettings: vi.fn(),
      listProductCatalogTexts: vi.fn(async () => []),
      replaceProductCatalogTexts: vi.fn(),
      listProductCatalogImageSources: vi.fn(async () => ({ sources: [], poolSize: 0 })),
      setProductCatalogImageSources: vi.fn()
    });
    expect(
      await screen.findByText(
        'Names and descriptions — nothing to write: the pool is empty and there is no fallback'
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Pictures — nothing to show: the pool is empty and there is no fallback link'
      )
    ).toBeTruthy();
    expect(screen.getByText('Price — 9 to 30 USD, a whole number per row')).toBeTruthy();
    expect(
      screen.getByText('A catalog cannot be made yet — fill what is marked above.')
    ).toBeTruthy();
  });

  it('says a catalog can be made once both pools have something', async () => {
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
      setProductCatalogSettings: vi.fn(),
      listProductCatalogTexts: vi.fn(async () => [
        { id: 't1', title: 'Nova Sage Jersey Hoodie', description: 'Soft.' }
      ]),
      replaceProductCatalogTexts: vi.fn(),
      listProductCatalogImageSources: vi.fn(async () => ({
        sources: [{ materialId: 'f1', kind: 'folder' as const, name: 'Shirts', imageCount: 4 }],
        poolSize: 4
      })),
      setProductCatalogImageSources: vi.fn()
    });
    expect(await screen.findByText('A catalog can be made from this.')).toBeTruthy();
    expect(screen.getByText('Names and descriptions — 1 in the pool')).toBeTruthy();
    expect(screen.getByText('Pictures — 4 in the pool')).toBeTruthy();
    // Nothing typed into the single values, so they are empty rather than in use.
    expect(screen.getByText('Empty')).toBeTruthy();
  });
});

describe('the pool, browsed and added to (024, US23)', () => {
  it('shows three, opens the rest with a search, and adds without replacing', async () => {
    const texts = Array.from({ length: 6 }, (_, index) => ({
      id: `t${index}`,
      title: index === 5 ? 'Ludia Navy Twill Wide Leg Jeans' : `Nova Sage Jersey Hoodie ${index}`,
      description: 'Soft.'
    }));
    const replace = vi.fn(async () => texts.length);
    renderSection({
      getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
      setProductCatalogSettings: vi.fn(),
      listProductCatalogTexts: vi.fn(async () => [...texts]),
      replaceProductCatalogTexts: replace,
      updateProductCatalogText: vi.fn()
    });
    const user = userEvent.setup();
    expect(await screen.findByText('Nova Sage Jersey Hoodie 0')).toBeTruthy();
    // Three of six in the tab; the rest behind one button.
    expect(screen.queryByText('Nova Sage Jersey Hoodie 4')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'View all (6)' }));
    await user.type(screen.getByLabelText('Search the pool'), 'ludia');
    expect(await screen.findByText('Found: 1')).toBeTruthy();
    expect(screen.getByText('Ludia Navy Twill Wide Leg Jeans')).toBeTruthy();
    await user.keyboard('{Escape}');

    const count = screen.getByLabelText('How many');
    await user.clear(count);
    await user.type(count, '2');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    // The six it had, then the two it made: adding is not replacing.
    expect(replace.mock.calls[0]![1]).toHaveLength(8);
    expect(replace.mock.calls[0]![1]![0]!.title).toBe('Nova Sage Jersey Hoodie 0');
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
// @ts-nocheck — section mocks intentionally use narrower callbacks for focused cases.
