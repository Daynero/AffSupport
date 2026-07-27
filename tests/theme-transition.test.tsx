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

type ViewTransitionStub = {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
};

function installViewTransitionStub() {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => {
    finish = resolve;
  });
  const startViewTransition = vi.fn((update: () => void) => {
    update();
    return {
      finished,
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      skipTransition: vi.fn()
    } satisfies ViewTransitionStub;
  });

  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: startViewTransition
  });

  return { finish, startViewTransition };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.dataset.theme = 'light';
  document.documentElement.classList.remove('theme-transitioning');
  document.querySelectorAll('style[data-theme-reveal]').forEach(style => style.remove());
  Reflect.deleteProperty(document, 'startViewTransition');
  vi.restoreAllMocks();
});

describe('theme reveal', () => {
  it('starts the circular wipe at the centre of the theme button', async () => {
    document.documentElement.dataset.theme = 'light';
    const { finish, startViewTransition } = installViewTransitionStub();
    render(<ThemeToggle />);

    const button = screen.getByRole('button', { name: 'Switch to dark mode' });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 900,
      y: 24,
      left: 900,
      top: 24,
      right: 932,
      bottom: 56,
      width: 32,
      height: 32,
      toJSON: () => ({})
    });

    fireEvent.click(button, { clientX: 400, clientY: 300 });

    expect(startViewTransition).toHaveBeenCalledOnce();
    const revealStyle = document.querySelector<HTMLStyleElement>('style[data-theme-reveal]');
    expect(revealStyle?.textContent).toContain('circle(0 at 916px 40px)');
    expect(revealStyle?.textContent).not.toContain('400px 300px');

    finish();
    await Promise.resolve();
    expect(document.querySelector('style[data-theme-reveal]')).toBeNull();
  });
});
