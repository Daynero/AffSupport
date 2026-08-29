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

vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => {
    throw new Error('the wizard step must not reach the network in these tests');
  },
  getSupabaseClient: () => null
}));

const { EnvironmentBadge } = await import('../apps/web/src/components/EnvironmentBadge');
const { BetaStorageNotice, externalStorageUnavailableInBeta } =
  await import('../apps/web/src/team/drive/BetaStorageNotice');
const { ConnectStorageFlow } = await import('../apps/web/src/team/storage/ConnectStorageFlow');

/** Step 2 renders before any of these are called; failing loudly proves it. */
const idleDriveClient = {
  pickerToken: () => Promise.reject(new Error('not reached')),
  chooseRoot: () => Promise.reject(new Error('not reached')),
  pickFolders: () => Promise.reject(new Error('not reached'))
} as unknown as Parameters<typeof ConnectStorageFlow>[0]['client'];

function renderFolderStep() {
  return render(
    <ConnectStorageFlow
      teamId="22222222-2222-4222-8222-222222222222"
      client={idleDriveClient}
      onConnected={() => {}}
      onBack={() => {}}
      onCancel={() => {}}
    />
  );
}

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

  it('stops advising once the beta has its own chooser keys', async () => {
    // Found on the beta stack after the documented opt-in was completed: the
    // wizard asks before any status call, so `undefined` kept the notice on a
    // screen whose storage was fully configured and working.
    environment.current = 'beta';
    const { pickerConfig } = await import('../apps/web/src/team/storage/loadPicker');
    expect(pickerConfig({})).toBeNull();
    expect(
      pickerConfig({ VITE_GOOGLE_PICKER_API_KEY: 'key', VITE_GOOGLE_PROJECT_NUMBER: '1' })
    ).toEqual({ apiKey: 'key', appId: '1' });
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

describe('the wizard step the notice is written for', () => {
  /**
   * The predicate above was already right about the wizard — the step just did
   * not ask it. Found on the beta stack: step 2 rendered an enabled primary
   * "Connect Google Drive" directly beneath its own "unavailable in beta"
   * notice, which is the silent control FR-015 forbids dressed as the way
   * forward. The settings panel guards the same control; this asserts the step
   * agrees, because agreement between two callers is what actually regressed.
   */
  it('offers no connect button in beta, only the reason there is none', () => {
    environment.current = 'beta';
    renderFolderStep();
    expect(screen.getByRole('note').textContent).toBeTruthy();
    expect(screen.queryByRole('button', { name: /drive/i })).toBeNull();
  });

  it('still offers it in production, where connecting is the point', () => {
    environment.current = 'production';
    renderFolderStep();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button', { name: /drive/i })).toBeTruthy();
  });
});
