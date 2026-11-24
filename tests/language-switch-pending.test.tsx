// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first switch to the other language downloads its dictionary (070 T072). On a slow line
 * the switch must not look dead while it waits (070 T069), and a failed download must not leave
 * it pointing at a language the page is not in.
 */
const loads = vi.hoisted(() => ({
  loaded: new Set<string>(['uk']),
  settle: null as null | { resolve: () => void; reject: (error: Error) => void }
}));

vi.mock('../apps/web/src/dictionaries', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/dictionaries')>();
  return {
    ...actual,
    isLanguageLoaded: (language: string) => loads.loaded.has(language),
    loadLanguage: (language: string) =>
      loads.loaded.has(language)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            loads.settle = {
              resolve: () => {
                loads.loaded.add(language);
                resolve();
              },
              reject
            };
          })
  };
});

const { LanguageSwitch } = await import('../apps/web/src/components/LanguageSwitch');

beforeEach(() => {
  localStorage.setItem('language', 'uk');
  loads.loaded = new Set(['uk']);
  loads.settle = null;
});
afterEach(cleanup);

const selected = () => document.querySelector('.language-switch .is-selected')?.textContent;

describe('the language switch on a slow line', () => {
  it('moves at once, says it is loading, and lands when the words arrive', async () => {
    render(<LanguageSwitch />);
    fireEvent.click(screen.getByText('EN'));
    expect(selected()).toBe('EN');
    expect(document.querySelector('.language-switch')?.className).toContain('is-pending');
    expect(screen.getByRole('status')).toBeTruthy();
    await act(async () => loads.settle?.resolve());
    expect(document.querySelector('.language-switch')?.className).not.toContain('is-pending');
    expect(screen.queryByRole('status')).toBeNull();
    expect(selected()).toBe('EN');
    expect(document.documentElement.lang).toBe('en');
  });

  it('goes back when the download fails', async () => {
    render(<LanguageSwitch />);
    fireEvent.click(screen.getByText('EN'));
    expect(selected()).toBe('EN');
    await act(async () => loads.settle?.reject(new Error('offline')));
    expect(selected()).toBe('UA');
    expect(document.querySelector('.language-switch')?.className).not.toContain('is-pending');
  });

  it('starts the download when pointed at, before the click', () => {
    render(<LanguageSwitch />);
    fireEvent.pointerEnter(document.querySelector('.language-switch')!.parentElement!);
    expect(loads.settle).not.toBeNull();
  });
});
