// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncProfileLanguage, useI18n } from '../apps/web/src/i18n';

beforeEach(() => localStorage.clear());

describe('language persistence', () => {
  it('follows a valid language change from another tab and ignores cleared or invalid values', () => {
    localStorage.setItem('language', 'en');
    const view = renderHook(() => useI18n());
    act(() =>
      window.dispatchEvent(new StorageEvent('storage', { key: 'language', newValue: 'uk' }))
    );
    expect(view.result.current.language).toBe('uk');
    expect(document.documentElement.lang).toBe('uk');
    expect(view.result.current.t('ongoingTimer', { time: '00:01:24' })).toBe('Триває 00:01:24');
    for (const newValue of [null, 'invalid']) {
      act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'language', newValue })));
      expect(view.result.current.language).toBe('uk');
    }
    act(() => window.dispatchEvent(new Event('wishly-language-changed')));
    expect(view.result.current.language).toBe('uk');
  });

  it('falls back to the browser language when its language list is empty', () => {
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue([]);
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('uk-UA');
    try {
      const view = renderHook(() => useI18n());
      expect(view.result.current.language).toBe('uk');
      expect(document.documentElement.lang).toBe('uk');
    } finally {
      languages.mockRestore();
      language.mockRestore();
    }
  });

  it('keeps Ukrainian after a reload and loading an English profile', () => {
    const first = renderHook(() => useI18n());
    act(() => first.result.current.setLanguage('uk'));
    first.unmount();

    const reloaded = renderHook(() => useI18n());
    act(() => syncProfileLanguage('en'));
    expect(reloaded.result.current.language).toBe('uk');
    expect(localStorage.getItem('language')).toBe('uk');
    expect(document.documentElement.lang).toBe('uk');
  });

  it('uses the profile when there is no saved choice, even after hooks mount', () => {
    const view = renderHook(() => useI18n());
    expect(localStorage.getItem('language')).toBeNull();
    act(() => syncProfileLanguage('uk'));
    expect(view.result.current.language).toBe('uk');
  });

  it('keeps an explicit English choice over a Ukrainian profile', () => {
    localStorage.setItem('language', 'uk');
    const view = renderHook(() => useI18n());
    act(() => view.result.current.setLanguage('en'));
    act(() => syncProfileLanguage('uk'));
    expect(view.result.current.language).toBe('en');
  });

  it('replaces an invalid saved value with the profile language', () => {
    localStorage.setItem('language', 'invalid');
    syncProfileLanguage('uk');
    expect(localStorage.getItem('language')).toBe('uk');
  });

  it('saves an explicit choice even when it matches the detected language', () => {
    const view = renderHook(() => useI18n());
    const chosen = view.result.current.language;
    act(() => view.result.current.setLanguage(chosen));
    act(() => syncProfileLanguage(chosen === 'uk' ? 'en' : 'uk'));
    expect(view.result.current.language).toBe(chosen);
    expect(localStorage.getItem('language')).toBe(chosen);
  });
});
