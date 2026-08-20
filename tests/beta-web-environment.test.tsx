// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const environment = vi.hoisted(() => ({ current: 'production' as 'production' | 'beta' }));

vi.mock('../apps/web/src/lib/config', () => ({
  configuredEnvironment: () => environment.current,
  configuredSiteUrl: () => 'http://127.0.0.1:5175',
  publicConfig: { ok: false, value: null, errors: [] }
}));

const { EnvironmentBadge } = await import('../apps/web/src/components/EnvironmentBadge');
const { BetaStorageNotice, externalStorageUnavailableInBeta } =
  await import('../apps/web/src/team/drive/BetaStorageNotice');

afterEach(() => {
  cleanup();
  environment.current = 'production';
});

describe('EnvironmentBadge', () => {
  it('is visible in a beta build', () => {
    // A mirror that looks identical to production is a hazard: the indicator
    // must be on screen without scrolling or opening a menu.
    environment.current = 'beta';
    render(<EnvironmentBadge />);
    expect(screen.getByRole('note').textContent ?? '').toMatch(/beta|бета/i);
  });

  it('renders nothing at all in production', () => {
    environment.current = 'production';
    const { container } = render(<EnvironmentBadge />);
    expect(container.innerHTML).toBe('');
  });
});

describe('external storage notice', () => {
  it('explains the unavailable state in beta instead of offering a broken connect', () => {
    environment.current = 'beta';
    render(<BetaStorageNotice state="unavailable" />);
    expect(screen.getByRole('note').textContent).toBeTruthy();
  });

  it('stays out of the way once external storage is connected in beta', () => {
    environment.current = 'beta';
    const { container } = render(<BetaStorageNotice state="connected" />);
    expect(container.innerHTML).toBe('');
  });

  it('advises when the state is not yet known, rather than assuming it works', () => {
    // The space-creation wizard reaches this step before any status call. Not
    // knowing that external storage is reachable must never read as knowing
    // that it is.
    environment.current = 'beta';
    expect(externalStorageUnavailableInBeta(undefined)).toBe(true);
  });

  it('never appears in production, whatever the state', () => {
    environment.current = 'production';
    for (const state of ['unavailable', 'connected', undefined]) {
      expect(externalStorageUnavailableInBeta(state)).toBe(false);
    }
  });
});
