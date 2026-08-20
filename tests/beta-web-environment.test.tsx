// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const environment = vi.hoisted(() => ({ current: 'production' as 'production' | 'beta' }));
/**
 * What the *validated* config resolves to. Normally the same as the build, but
 * a beta profile with a mistake in it fails validation and falls back to
 * production — which is the case the badge has to survive.
 */
const configuredOverride = vi.hoisted(() => ({
  current: null as 'production' | 'beta' | null
}));

vi.mock('../apps/web/src/lib/config', () => ({
  // `builtForEnvironment` is what the badge reads: it answers from the build's
  // own value rather than the validated config, so a beta build with a mistake
  // in its profile still looks like beta. The rest of the app keeps using
  // `configuredEnvironment`, which fails closed to production.
  builtForEnvironment: () => environment.current,
  configuredEnvironment: () => configuredOverride.current ?? environment.current,
  configuredSiteUrl: () => 'http://127.0.0.1:5175',
  publicConfig: { ok: false, value: null, errors: [] }
}));

const { EnvironmentBadge } = await import('../apps/web/src/components/EnvironmentBadge');
const { BetaStorageNotice, externalStorageUnavailableInBeta } =
  await import('../apps/web/src/team/drive/BetaStorageNotice');

afterEach(() => {
  cleanup();
  environment.current = 'production';
  configuredOverride.current = null;
});

describe('EnvironmentBadge', () => {
  it('is visible in a beta build', () => {
    // A mirror that looks identical to production is a hazard: the indicator
    // must be on screen without scrolling or opening a menu.
    environment.current = 'beta';
    render(<EnvironmentBadge />);
    expect(screen.getByRole('note').textContent ?? '').toMatch(/beta|бета/i);
  });

  it('still shows in a beta build whose configuration failed validation', () => {
    // Fail-closed is right for every rule keyed on the environment, and wrong
    // for the indicator: a broken .env.beta would otherwise hide the badge on
    // exactly the build most likely to be mistaken for production.
    environment.current = 'beta';
    configuredOverride.current = 'production';
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
