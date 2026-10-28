// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
        <ProductCatalogSettingsSection
          teamId={TEAM_ID}
          client={client}
          openEditor={
            client.listProductCatalogTexts
              ? 'product-catalog-texts-title'
              : client.listProductCatalogImageSources
                ? 'product-catalog-images-title'
                : 'product-catalog-settings-title'
          }
        />
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
    expect(screen.getAllByText('Not saved yet').length).toBeGreaterThan(0);
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
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Generate names and descriptions' })
    );
    expect(await screen.findByText(/for clothing only/)).toBeTruthy();
    const count = screen.getByLabelText('Variants to add');
    await user.clear(count);
    await user.type(count, '3');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls[0]![1]).toHaveLength(3);
    expect(await screen.findByText('Saved: 3')).toBeTruthy();
    // A pool that exists is replaced only after saying so.
    await user.click(screen.getByRole('button', { name: 'Generate names and descriptions' }));
    await user.click(screen.getByRole('button', { name: 'Replace all names and descriptions' }));
    expect(await screen.findByText('Replace all names and descriptions?')).toBeTruthy();
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
    expect(await screen.findByText('Add missing content and save the price.')).toBeTruthy();
    expect(screen.queryByText('Ready to create a catalog')).toBeNull();
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
    expect(await screen.findByText('Ready to create a catalog')).toBeTruthy();
    expect(screen.getByText('Saved: 1')).toBeTruthy();
    expect(screen.getByText('Images: 4')).toBeTruthy();
    // Nothing typed into the single values, so they are empty rather than in use.
    expect(screen.getByText('Empty')).toBeTruthy();
  });
});

describe('the pool, browsed and added to (024, US23)', () => {
  it('keeps long samples out of settings, searches all names, and adds without replacing', async () => {
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
    await screen.findByRole('button', { name: 'Browse and edit (6)' });
    expect(screen.queryByText('Nova Sage Jersey Hoodie 0')).toBeNull();
    // Three of six in the tab; the rest behind one button.
    expect(screen.queryByText('Nova Sage Jersey Hoodie 4')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Browse and edit (6)' }));
    await user.type(screen.getByLabelText('Search names or descriptions'), 'ludia');
    expect(await screen.findByText('Found: 1')).toBeTruthy();
    expect(screen.getByText('Ludia Navy Twill Wide Leg Jeans')).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Generate names and descriptions' }));

    const count = screen.getByLabelText('Variants to add');
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
    expect(await screen.findByText('Images: 13')).toBeTruthy();
    expect(screen.getByText('12 images')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove plain.png from the pictures' }));
    await waitFor(() =>
      expect(setSources).toHaveBeenCalledWith(TEAM_ID, [{ materialId: 'f1', kind: 'folder' }])
    );
  });
});
// @ts-nocheck — section mocks intentionally use narrower callbacks for focused cases.

it('shows generation failure inside the dialog and retries reading without regenerating', async () => {
  const user = userEvent.setup();
  const replace = vi.fn().mockRejectedValue(new Error('offline'));
  const list = vi.fn(async () => []);
  renderSection({
    getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
    setProductCatalogSettings: vi.fn(),
    listProductCatalogTexts: list,
    replaceProductCatalogTexts: replace
  });
  await user.click(await screen.findByRole('button', { name: 'Generate names and descriptions' }));
  await user.click(screen.getByRole('button', { name: 'Generate', exact: true }));
  const dialog = within(screen.getByRole('dialog', { name: 'Generate names and descriptions' }));
  await dialog.findByRole('alert');
  await user.click(dialog.getByRole('button', { name: 'Retry' }));
  await dialog.findByRole('button', { name: 'Generate', exact: true });
  expect(replace).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledTimes(2);
});

function renderEditableSection(client: Client) {
  return render(
    <TeamProvider initialTeams={[owned]} realtime={false}>
      <ToastProvider>
        <ProductCatalogSettingsSection teamId={TEAM_ID} client={client} />
      </ToastProvider>
    </TeamProvider>
  );
}

// Select the disclosure by its stable association, without depending on changing count summaries.
async function openEditor(id: string) {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-controls="accordion-${id}"]`
  )!;
  if (trigger.getAttribute('aria-expanded') !== 'true') await userEvent.click(trigger);
}

function valuesClient() {
  return {
    getProductCatalogSettings: vi.fn().mockResolvedValue(stored),
    setProductCatalogSettings: vi.fn(async (_team, input) => ({ ...stored, ...input }))
  };
}

describe('catalog editing boundaries', () => {
  it('keeps failed image reads unknown and recovers through Retry', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ sources: [], poolSize: 0 });
    renderEditableSection({ ...valuesClient(), listProductCatalogImageSources: load });
    await screen.findByText('Could not load');
    expect(screen.queryByText('Ready to create a catalog')).toBeNull();
    expect(screen.queryByText('Images: 0')).toBeNull();
    await openEditor('product-catalog-images-title');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Images: 0')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('retains a price draft while switching editors and exposes its dirty summary', async () => {
    renderEditableSection(valuesClient());
    await openEditor('product-catalog-settings-title');
    const input = await screen.findByLabelText('From');
    await userEvent.clear(input);
    await userEvent.type(input, '17');
    await openEditor('product-catalog-fallback-title');
    expect(
      document.querySelector('button[aria-controls="accordion-product-catalog-settings-title"]')
        ?.textContent
    ).toContain('Not saved yet');
    await openEditor('product-catalog-settings-title');
    expect(screen.getByLabelText('From')).toHaveProperty('value', '17');
  });

  it('saves price without publishing the fallback draft', async () => {
    const api = valuesClient();
    renderEditableSection(api);
    await openEditor('product-catalog-fallback-title');
    await userEvent.type(await screen.findByLabelText('Title'), 'Draft title');
    await openEditor('product-catalog-settings-title');
    await userEvent.clear(screen.getByLabelText('From'));
    await userEvent.type(screen.getByLabelText('From'), '17');
    await userEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() =>
      expect(api.setProductCatalogSettings).toHaveBeenCalledWith(TEAM_ID, {
        title: null,
        description: null,
        imageLink: null,
        priceMin: 17,
        priceMax: 30
      })
    );
    await openEditor('product-catalog-fallback-title');
    expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Draft title');
  });

  it('saves fallbacks using persisted prices even when the price draft is invalid', async () => {
    const api = valuesClient();
    renderEditableSection(api);
    await openEditor('product-catalog-settings-title');
    await userEvent.clear(await screen.findByLabelText('From'));
    await openEditor('product-catalog-fallback-title');
    await userEvent.type(screen.getByLabelText('Title'), 'Saved title');
    await userEvent.click(screen.getByRole('button', { name: 'Save the fallbacks' }));
    await waitFor(() =>
      expect(api.setProductCatalogSettings).toHaveBeenCalledWith(TEAM_ID, {
        title: 'Saved title',
        description: null,
        imageLink: null,
        priceMin: 9,
        priceMax: 30
      })
    );
    await openEditor('product-catalog-settings-title');
    expect(screen.getByLabelText('From')).toHaveProperty('value', '');
  });

  it('blocks edits during an outstanding save and restores editing after confirmation', async () => {
    let resolveSave!: (value: ProductCatalogSettings) => void;
    const api = valuesClient();
    api.setProductCatalogSettings = vi.fn(
      () =>
        new Promise<ProductCatalogSettings>(resolve => {
          resolveSave = resolve;
        })
    );
    renderEditableSection(api);
    await openEditor('product-catalog-settings-title');
    const from = await screen.findByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, '17');
    await userEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(from).toHaveProperty('readOnly', true);
    await userEvent.type(from, '2');
    expect(from).toHaveProperty('value', '17');
    await openEditor('product-catalog-fallback-title');
    expect(screen.getByLabelText('Title')).toHaveProperty('readOnly', true);
    await act(async () => resolveSave({ ...stored, priceMin: 17 }));
    expect(screen.getByLabelText('Title')).toHaveProperty('readOnly', false);
    await openEditor('product-catalog-settings-title');
    expect(screen.getByLabelText('From')).toHaveProperty('value', '17');
    expect(screen.getByLabelText('From')).toHaveProperty('readOnly', false);
  });

  it('blocks over-capacity generation and offers the exact remaining amount', async () => {
    const replace = vi.fn();
    renderEditableSection({
      ...valuesClient(),
      listProductCatalogTexts: vi.fn().mockResolvedValue(
        Array.from({ length: 999 }, (_, i) => ({
          id: String(i),
          title: `Item ${i}`,
          description: 'Text'
        }))
      ),
      replaceProductCatalogTexts: replace
    });
    await openEditor('product-catalog-texts-title');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Generate names and descriptions' })
    );
    const count = await screen.findByLabelText('Variants to add');
    await userEvent.clear(count);
    await userEvent.type(count, '2');
    expect(screen.getByRole('button', { name: 'Add', exact: true })).toHaveProperty(
      'disabled',
      true
    );
    expect(replace).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Room for 1 more — use this amount' })
    );
    expect(count).toHaveProperty('value', '1');
    expect(screen.getByText('Add 1 · total 1000')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add', exact: true })).toHaveProperty(
      'disabled',
      false
    );
  });
});
