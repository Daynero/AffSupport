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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Team workspace' }));

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
});
