// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    filters?: Partial<CatalogSearchFilters>;
    facets?: Record<string, { value: string; count: number }[]>;
  } = {},
  handlers: { onSet?: ReturnType<typeof vi.fn> } = {}
) {
  const onSet = handlers.onSet ?? vi.fn();
  render(
    <CatalogFilters
      filters={{ ...EMPTY_FILTERS, ...overrides.filters }}
      vocabulary={VOCABULARY}
      facets={overrides.facets}
      onSet={onSet}
      onRemove={() => {}}
      onClear={() => {}}
    />
  );
  return onSet;
}

const optionsOf = (name: string) =>
  within(screen.getByRole('combobox', { name })).getAllByRole('option') as HTMLOptionElement[];

describe('catalog filters', () => {
  it('offers the types the results actually hold, and chooses one', () => {
    const onSet = renderPanel({
      facets: {
        originalType: [
          { value: 'video/mp4', count: 3 },
          { value: 'application/zip', count: 1 }
        ]
      }
    });

    const options = optionsOf('Original type');
    expect(options.map(option => option.textContent)).toEqual(['Any', 'MP4', 'ZIP']);
    // The value written to the query is the type itself, not its short name.
    expect(options.map(option => option.value)).toEqual(['', 'video/mp4', 'application/zip']);

    fireEvent.change(screen.getByRole('combobox', { name: 'Original type' }), {
      target: { value: 'video/mp4' }
    });
    expect(onSet).toHaveBeenCalledWith('originalType', 'video/mp4');
  });

  /* Facets narrow with the search, so a chosen type that no longer appears in
     them must still be in the list — otherwise there is no way to change it. */
  it('keeps the chosen type listed even when the facets no longer name it', () => {
    renderPanel({
      filters: { originalType: ['image/png'] },
      facets: { originalType: [{ value: 'video/mp4', count: 3 }] }
    });

    expect(optionsOf('Original type').map(option => option.value)).toContain('image/png');
  });

  it('says every fixed value in words rather than in storage codes', () => {
    renderPanel();

    expect(optionsOf('Category').map(option => option.textContent)).toContain('Video');
    expect(optionsOf('Kind').map(option => option.textContent)).toEqual([
      'Any',
      'File',
      'Folder',
      'Shortcut'
    ]);
    // GEO stays a code, because that is what a GEO is called.
    expect(optionsOf('Missing metadata').map(option => option.textContent)).toEqual([
      'Any',
      'GEO',
      'Offer',
      'Language'
    ]);
  });

  it('names an active filter and its value on the chip that removes it', () => {
    renderPanel({ filters: { kind: ['folder'] } });

    expect(screen.getByRole('button', { name: 'Remove Kind: Folder filter' })).toBeTruthy();
  });
});
