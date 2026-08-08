// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: {
    setLocale: vi.fn(),
    track: vi.fn()
  }
}));

import { ThemeToggle } from '../apps/web/src/components/ThemeToggle';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.dataset.theme = 'light';
  document.documentElement.classList.remove('is-theming');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('theme transition', () => {
  it('arms the global colour fade before committing the selected theme', () => {
    vi.useFakeTimers();
    document.documentElement.dataset.theme = 'light';
    render(<ThemeToggle />);

    const button = screen.getByRole('button', { name: 'Switch to dark mode' });
    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('is-theming')).toBe(true);

    vi.advanceTimersByTime(856);
    expect(document.documentElement.classList.contains('is-theming')).toBe(false);
  });
});
