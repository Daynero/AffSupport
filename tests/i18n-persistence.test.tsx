// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { syncProfileLanguage, useI18n } from '../apps/web/src/i18n';

beforeEach(() => localStorage.clear());

describe('language persistence', () => {
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
