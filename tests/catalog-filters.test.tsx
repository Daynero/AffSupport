// @vitest-environment jsdom
import React from 'react';
import userEvent from '@testing-library/user-event';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogSearchFilters } from '@video-compressor/shared';
import { CatalogFilters } from '../apps/web/src/team/catalog/CatalogFilters';

/**
 * The search filter panel (020): what it offers, and in whose words.
 *
 * "Original type" had no dictionary to read from and was given an empty list —
 * seven controls on screen and one of them could never be used. And every fixed
 * set was offered by its storage code (`video`, `file`, `geo`) to a reader who
 * had asked for another language.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EMPTY_FILTERS: CatalogSearchFilters = {
  geo: [],
  language: [],
  offer: [],
  category: [],
  originalType: [],
  kind: [],
  unfilled: []
};

const VOCABULARY = { geo: ['UA', 'PL'], languages: ['uk', 'en'], offers: ['Pro Caps'], tags: [] };

function renderPanel(
  overrides: {
    vocabulary?: typeof VOCABULARY & { usedGeo?: string[]; usedLanguages?: string[] };
    filters?: Partial<CatalogSearchFilters>;
    facets?: Record<string, { value: string; count: number }[]>;
  } = {},
  handlers: { onSet?: ReturnType<typeof vi.fn> } = {}
) {
  const onSet = handlers.onSet ?? vi.fn();
  render(
    <CatalogFilters
      filters={{ ...EMPTY_FILTERS, ...overrides.filters }}
      vocabulary={overrides.vocabulary ?? VOCABULARY}
      facets={overrides.facets}
      onSet={onSet}
      onRemove={() => {}}
      onClear={() => {}}
    />
  );
  return onSet;
}

/**
 * One facet, driven the way a person drives it.
 *
 * The control is a listbox behind a trigger now, so its options exist only
 * while it is open — which is also the only time anybody can see them. Found
 * through the caption's id rather than its words, because an open listbox
 * portals its options to the body and more than one control on this panel can
 * end up carrying the same text.
 */
const FACET_KEY: Record<string, string> = {
  GEO: 'geo',
  Language: 'language',
  Offer: 'offer',
  Category: 'category',
  'Original type': 'originalType',
  Kind: 'kind',
  'Missing metadata': 'unfilled'
};

async function openFacet(name: string) {
  const user = userEvent.setup();
  // An open listbox hides the rest of the page from assistive technology, and
  // therefore from these queries — which is correct behaviour and means one has
  // to be closed before the next can be reached.
  if (document.querySelector('[role="listbox"]')) await user.keyboard('{Escape}');
  const caption = document.getElementById(`catalog-facet-${FACET_KEY[name]}`);
  const facet = caption?.closest('.team-catalog-facet');
  if (!facet) throw new Error(`no facet named "${name}"`);
  const trigger = within(facet as HTMLElement).getByRole('button');
  await user.click(trigger);
  const list = await screen.findByRole('listbox');
  return { user, list };
}

/** What the facet offers, in the words it offers them. */
async function optionTexts(name: string) {
  const { list } = await openFacet(name);
  return within(list)
    .getAllByRole('option')
    .map(option => option.textContent);
}

describe('catalog filters', () => {
  it('offers only the GEO and languages the files carry, by name (024)', async () => {
    renderPanel({
      vocabulary: { ...VOCABULARY, usedGeo: ['PL'], usedLanguages: ['uk'] },
      filters: { geo: ['PL'] }
    });
    expect(await optionTexts('GEO')).toEqual(expect.arrayContaining(['Poland']));
    expect(await optionTexts('GEO')).not.toContain('Ukraine');
    expect(await optionTexts('Language')).toEqual(expect.arrayContaining(['Ukrainian']));
    expect(await optionTexts('Language')).not.toContain('English');
  });

  it('offers the types the results actually hold, and chooses one', async () => {
    const onSet = renderPanel({
      facets: {
        originalType: [
          { value: 'video/mp4', count: 3 },
          { value: 'application/zip', count: 1 }
        ]
      }
    });

    const { user, list } = await openFacet('Original type');
    expect(
      within(list)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Any', 'MP4', 'ZIP']);

    // The reader picks the short name; what reaches the query is the type.
    await user.click(within(list).getByRole('option', { name: 'MP4' }));
    expect(onSet).toHaveBeenCalledWith('originalType', 'video/mp4');
  });

  /* Facets narrow with the search, so a chosen type that no longer appears in
     them must still be in the list — otherwise there is no way to change it. */
  it('keeps the chosen type listed even when the facets no longer name it', async () => {
    renderPanel({
      filters: { originalType: ['image/png'] },
      facets: { originalType: [{ value: 'video/mp4', count: 3 }] }
    });

    expect(await optionTexts('Original type')).toContain('PNG');
  });

  it('says every fixed value in words rather than in storage codes', async () => {
    renderPanel();

    expect(await optionTexts('Category')).toContain('Video');
    expect(await optionTexts('Kind')).toEqual(['Any', 'File', 'Folder', 'Shortcut']);
    // GEO stays a code, because that is what a GEO is called.
    expect(await optionTexts('Missing metadata')).toEqual(['Any', 'GEO', 'Offer', 'Language']);
  });

  it('names an active filter and its value on the chip that removes it', () => {
    renderPanel({ filters: { kind: ['folder'] } });

    expect(screen.getByRole('button', { name: 'Remove Kind: Folder filter' })).toBeTruthy();
  });
});
