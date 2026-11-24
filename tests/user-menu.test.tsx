// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/src/auth/AuthContext.js', () => ({
  useAuth: () => ({
    user: { email: 'owner@example.test' },
    profile: {
      display_name: 'Owner',
      email: 'owner@example.test',
      avatar_url: null
    },
    isAdmin: false,
    signOut: vi.fn(),
    status: 'authenticated'
  })
}));

vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

import { UserMenu } from '../apps/web/src/components/UserMenu';
import { AgentContextOverride } from '../apps/web/src/AgentContext';
import { OPEN_NATIVE_APP_UPDATE } from '../apps/web/src/updates/openNativeAppUpdate';
import { fakeAgentValue } from './support/fake-agent';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('user menu', () => {
  it('keeps Team Workspace reachable from every authenticated page', () => {
    render(<UserMenu />);

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spaces' }));

    expect(location.pathname).toBe('/team');
  });

  it('opens a technical-support message dialog without donation options', () => {
    render(<UserMenu />);

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Technical support' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Technical support' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Your message' })).toBeTruthy();
    expect(screen.queryByText('Donate to development')).toBeNull();
  });

  it('reopens Soty updates from the menu, even after an update was cancelled', () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_NATIVE_APP_UPDATE, opened);
    render(
      <AgentContextOverride
        value={fakeAgentValue({ capabilities: ['event-stream', 'native-app-updates-v1'] })}
      >
        <UserMenu />
      </AgentContextOverride>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Soty updates' }));
    expect(opened).toHaveBeenCalledOnce();
    window.removeEventListener(OPEN_NATIVE_APP_UPDATE, opened);
  });

  it('offers no updates entry without an agent that updates itself', () => {
    render(
      <AgentContextOverride value={fakeAgentValue({ capabilities: ['event-stream'] })}>
        <UserMenu />
      </AgentContextOverride>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Soty updates' })).toBeNull();
  });

  /** A phone (070, T077): the bar keeps the mark, the state and this button; theme and language
      come in here. */
  function asPhone(phone: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: phone && query === '(max-width: 640px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }));
  }

  it('keeps theme and language in the bar on a wider screen, not in the menu', () => {
    asPhone(false);
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    expect(screen.queryByRole('menuitem', { name: /light mode|dark mode/u })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Language/u })).toBeNull();
    vi.unstubAllGlobals();
  });

  it('offers the other theme and the other language on a phone, each named for what it does', () => {
    asPhone(true);
    document.documentElement.dataset.theme = 'dark';
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to light mode' }));
    expect(localStorage.getItem('theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Language: Українська' }));
    expect(localStorage.getItem('language')).toBe('uk');
    vi.unstubAllGlobals();
  });
});
