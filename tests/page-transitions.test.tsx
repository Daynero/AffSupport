// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The persistent shell renders the real HomePage and tool registry; stub the
// heavy tool pages, agent connection and analytics so the shell mounts alone.
vi.mock('../apps/web/src/App.js', async () => {
  const ReactModule = await import('react');
  return {
    default: () => ReactModule.createElement('main', { 'data-testid': 'compressor-page' }),
    Header: () => ReactModule.createElement('header', { className: 'topbar' }),
    Onboarding: () => null
  };
});
vi.mock('../apps/web/src/landing/LandingOptimizerPage.js', () => ({ default: () => null }));
vi.mock('../apps/web/src/transcription/TranscriptionPage.js', () => ({ default: () => null }));
vi.mock('../apps/web/src/pages/AccountPage.js', async () => {
  const ReactModule = await import('react');
  return {
    default: () => ReactModule.createElement('main', { 'data-testid': 'account-page' })
  };
});
vi.mock('../apps/web/src/pages/AdminPage.js', () => ({ default: () => null }));
vi.mock('../apps/web/src/auth/AuthScreens.js', () => ({ ProfileOnboarding: () => null }));
vi.mock('../apps/web/src/components/ReleaseUpdateNotice.js', () => ({ default: () => null }));
vi.mock('../apps/web/src/components/LocalAppDialog.js', () => ({ default: () => null }));
vi.mock('../apps/web/src/AgentContext.js', async () => {
  const ReactModule = await import('react');
  return {
    AgentProvider: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useAgent: () => ({
      connection: 'connected',
      connectedOnce: true,
      reconnect: vi.fn(),
      capabilities: ['landing'],
      toolAvailable: () => true
    }),
    // The header's power throttle reads the agent optionally, so it can render
    // its "not connected" state instead of throwing outside a provider.
    useOptionalAgent: () => null
  };
});
vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

import ProtectedSoty from '../apps/web/src/ProtectedSoty';
import { navigateTo, useBrowserRoute, usePageEntrance } from '../apps/web/src/lib/navigation';

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
    };
  });
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: startViewTransition
  });
  return { finish, startViewTransition };
}

function RouteProbe() {
  const route = useBrowserRoute();
  const path = new URL(route, location.origin).pathname;
  return (
    <div>
      <span data-testid="path">{path}</span>
      <EntranceProbe key={path} />
    </div>
  );
}

function EntranceProbe() {
  const entering = usePageEntrance();
  return <span data-testid="entrance">{entering ? 'enter' : 'silent'}</span>;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'en');
  history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('wishly-page-transition', 'is-theming');
  Reflect.deleteProperty(document, 'startViewTransition');
  vi.restoreAllMocks();
});

describe('persistent shell', () => {
  it('keeps the same header DOM node across page navigations', () => {
    const { rerender } = render(<ProtectedSoty path="/" />);
    const header = document.querySelector('header.topbar');
    expect(header).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Soty Tools' })).toBeTruthy();

    rerender(<ProtectedSoty path="/compressor" />);
    expect(screen.getByTestId('compressor-page')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Soty Tools' })).toBeNull();
    expect(document.querySelector('header.topbar')).toBe(header);

    rerender(<ProtectedSoty path="/account" />);
    expect(screen.getByTestId('account-page')).toBeTruthy();
    expect(document.querySelector('header.topbar')).toBe(header);
  });

  it('renders exactly one header inside the shell around the page viewport', () => {
    render(<ProtectedSoty path="/compressor" />);
    expect(document.querySelectorAll('header').length).toBe(1);
    const viewport = document.querySelector('.app-shell > .page-viewport');
    expect(viewport?.querySelector('[data-testid="compressor-page"]')).toBeTruthy();
    expect(viewport?.querySelector('header')).toBeNull();
  });
});

describe('route changes without the View Transitions API', () => {
  it('falls back to a plain swap in browsers without startViewTransition', () => {
    // jsdom has no document.startViewTransition — this is the natural fallback.
    render(<RouteProbe />);
    expect(screen.getByTestId('path').textContent).toBe('/');

    act(() => navigateTo('/account'));

    expect(screen.getByTestId('path').textContent).toBe('/account');
    expect(location.pathname).toBe('/account');
    expect(document.documentElement.classList.contains('wishly-page-transition')).toBe(false);
    // Without a view transition the freshly mounted page plays its entrance.
    expect(screen.getByTestId('entrance').textContent).toBe('enter');
  });

  it('skips the view transition while a theme transition is running', () => {
    const { startViewTransition } = installViewTransitionStub();
    document.documentElement.classList.add('is-theming');
    render(<RouteProbe />);

    act(() => navigateTo('/compressor'));

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(screen.getByTestId('path').textContent).toBe('/compressor');
  });

  it('skips the view transition when the user prefers reduced motion', () => {
    const { startViewTransition } = installViewTransitionStub();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    render(<RouteProbe />);

    act(() => navigateTo('/compressor'));

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(screen.getByTestId('path').textContent).toBe('/compressor');
    vi.unstubAllGlobals();
  });
});

describe('route view transitions', () => {
  it('wraps the route swap in a view transition and suppresses the page entrance', async () => {
    const { finish, startViewTransition } = installViewTransitionStub();
    render(<RouteProbe />);
    expect(screen.getByTestId('entrance').textContent).toBe('enter');

    act(() => navigateTo('/compressor'));

    expect(startViewTransition).toHaveBeenCalledOnce();
    // flushSync commits the new page inside the transition callback...
    expect(screen.getByTestId('path').textContent).toBe('/compressor');
    // ...the wishly-page group is active while the transition runs...
    expect(document.documentElement.classList.contains('wishly-page-transition')).toBe(true);
    // ...and the page skips .page-enter — the transition animates it instead.
    expect(screen.getByTestId('entrance').textContent).toBe('silent');

    finish();
    await act(() => Promise.resolve());
    expect(document.documentElement.classList.contains('wishly-page-transition')).toBe(false);

    // The next mount outside a transition plays the entrance again.
    Reflect.deleteProperty(document, 'startViewTransition');
    act(() => navigateTo('/account'));
    expect(screen.getByTestId('entrance').textContent).toBe('enter');
  });
});
