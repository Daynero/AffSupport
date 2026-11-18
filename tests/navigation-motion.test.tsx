// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

import {
  BEFORE_NAVIGATION_EVENT,
  SETTLE_BEFORE_REVEAL_MS,
  WAIT_BEFORE_SKELETON_MS,
  navigateTo,
  registerRoutePreparer,
  resetNavigationForTests,
  useBrowserRoute
} from '../apps/web/src/lib/navigation';
import { setNavigationAnalyticsForTests } from '../apps/web/src/lib/navigation-analytics';
import { resetMotionQualityForTests } from '../apps/web/src/lib/motion-quality';

type Transition = {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: ReturnType<typeof vi.fn>;
  finish: () => void;
};

function installViewTransitionStub() {
  const transitions: Transition[] = [];
  const startViewTransition = vi.fn((update: () => void) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => {
      finish = resolve;
    });
    update();
    const transition: Transition = {
      finished,
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      skipTransition: vi.fn(() => finish()),
      finish
    };
    transitions.push(transition);
    return transition;
  });
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: startViewTransition
  });
  return { startViewTransition, transitions };
}

function RouteProbe() {
  const route = useBrowserRoute();
  return <span data-testid="route">{route}</span>;
}

const sent: Array<Record<string, unknown>> = [];
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetNavigationForTests();
  resetMotionQualityForTests();
  sent.length = 0;
  setNavigationAnalyticsForTests({
    sender: properties => sent.push(properties as unknown as Record<string, unknown>),
    random: () => 0
  });
  history.replaceState(null, '', '/');
  scrollTo = vi.fn((options: ScrollToOptions) => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: options.top ?? 0 });
  });
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove(
    'wishly-page-transition',
    'wishly-section-transition',
    'is-theming'
  );
  Reflect.deleteProperty(document, 'startViewTransition');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('motion kinds', () => {
  it('moves between sections of a space with the section group, not the page', () => {
    const { startViewTransition } = installViewTransitionStub();
    history.replaceState(null, '', '/team/space-1/explorer');
    render(<RouteProbe />);
    act(() => navigateTo('/team/space-1/tasks'));
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('wishly-section-transition')).toBe(true);
    expect(document.documentElement.classList.contains('wishly-page-transition')).toBe(false);
  });

  it('crosses the workspace boundary with a page move instead of a direct swap', () => {
    const { startViewTransition } = installViewTransitionStub();
    render(<RouteProbe />);
    act(() => navigateTo('/team/space-1/explorer'));
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('wishly-page-transition')).toBe(true);
  });

  it('changes a query within the same screen with no page motion and no scroll', () => {
    const { startViewTransition } = installViewTransitionStub();
    history.replaceState(null, '', '/team/space-1/explorer');
    render(<RouteProbe />);
    act(() => navigateTo('/team/space-1/explorer?folder=abc'));
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(screen.getByTestId('route').textContent).toBe('/team/space-1/explorer?folder=abc');
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('one transition at a time', () => {
  it('starts one transition for a navigation however many components read the route', () => {
    const { startViewTransition } = installViewTransitionStub();
    render(
      <>
        <RouteProbe />
        <RouteProbe />
        <RouteProbe />
      </>
    );
    act(() => navigateTo('/compressor'));
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(screen.getAllByTestId('route').map(node => node.textContent)).toEqual([
      '/compressor',
      '/compressor',
      '/compressor'
    ]);
  });

  it('commits Back once for every reader of the route', () => {
    const { startViewTransition } = installViewTransitionStub();
    render(
      <>
        <RouteProbe />
        <RouteProbe />
      </>
    );
    act(() => navigateTo('/compressor'));
    startViewTransition.mockClear();
    history.replaceState(null, '', '/');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(screen.getAllByTestId('route').map(node => node.textContent)).toEqual(['/', '/']);
  });

  it('skips the running transition when a newer navigation starts', () => {
    const { startViewTransition, transitions } = installViewTransitionStub();
    render(<RouteProbe />);
    act(() => navigateTo('/compressor'));
    act(() => navigateTo('/account'));
    expect(startViewTransition).toHaveBeenCalledTimes(2);
    expect(transitions[0]!.skipTransition).toHaveBeenCalled();
    expect(screen.getByTestId('route').textContent).toBe('/account');
  });

  it('keeps the newer transition class when the skipped one finishes late', async () => {
    const { transitions } = installViewTransitionStub();
    history.replaceState(null, '', '/team/space-1/explorer');
    render(<RouteProbe />);
    act(() => navigateTo('/compressor'));
    act(() => navigateTo('/account'));
    await act(async () => {
      transitions[0]!.finish();
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('wishly-page-transition')).toBe(true);
    await act(async () => {
      transitions[1]!.finish();
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('wishly-page-transition')).toBe(false);
  });

  it('applies a redirect inside the change already on screen', () => {
    const { startViewTransition } = installViewTransitionStub();
    render(<RouteProbe />);
    act(() => navigateTo('/team'));
    act(() => navigateTo('/team/space-1/explorer', true));
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(screen.getByTestId('route').textContent).toBe('/team/space-1/explorer');
  });
});

describe('preparing the destination', () => {
  it('keeps the current screen until the destination code has arrived', async () => {
    render(<RouteProbe />);
    let arrive!: () => void;
    const chunk = new Promise<void>(resolve => {
      arrive = resolve;
    });
    act(() => navigateTo('/compressor', { prepare: () => chunk }));
    expect(screen.getByTestId('route').textContent).toBe('/');
    expect(location.pathname).toBe('/');
    await act(async () => {
      arrive();
      await chunk;
      await Promise.resolve();
    });
    expect(screen.getByTestId('route').textContent).toBe('/compressor');
  });

  it('moves after the skeleton delay and lets the skeleton show at once', async () => {
    vi.useFakeTimers();
    render(<RouteProbe />);
    act(() => navigateTo('/compressor', { prepare: () => new Promise(() => undefined) }));
    expect(location.pathname).toBe('/');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SKELETON_MS);
    });
    expect(screen.getByTestId('route').textContent).toBe('/compressor');
    expect(document.documentElement.dataset.navWaited).toBe('true');
  });

  it('asks the registered preparers when the caller passes none', async () => {
    render(<RouteProbe />);
    let arrive!: () => void;
    const chunk = new Promise<void>(resolve => {
      arrive = resolve;
    });
    const preparer = vi.fn((path: string) => (path === '/stitcher' ? chunk : undefined));
    registerRoutePreparer(preparer);
    act(() => navigateTo('/stitcher'));
    expect(preparer).toHaveBeenCalledWith('/stitcher');
    expect(location.pathname).toBe('/');
    await act(async () => {
      arrive();
      await chunk;
      await Promise.resolve();
    });
    expect(location.pathname).toBe('/stitcher');
  });

  it('lets the last of two waiting navigations win', async () => {
    render(<RouteProbe />);
    let arriveFirst!: () => void;
    const first = new Promise<void>(resolve => {
      arriveFirst = resolve;
    });
    act(() => navigateTo('/compressor', { prepare: () => first }));
    act(() => navigateTo('/account'));
    expect(location.pathname).toBe('/account');
    await act(async () => {
      arriveFirst();
      await first;
      await Promise.resolve();
    });
    expect(location.pathname).toBe('/account');
    expect(screen.getByTestId('route').textContent).toBe('/account');
  });
});

describe('scroll and focus', () => {
  it('opens a new page at the top and returns to the remembered place on Back', async () => {
    render(<RouteProbe />);
    act(() => navigateTo('/compressor'));
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 });
    act(() => navigateTo('/account'));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 0 }));

    await act(async () => {
      history.back();
      await new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
    });
    expect(screen.getByTestId('route').textContent).toBe('/compressor');
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 640 }));
  });

  it('moves focus into the new screen only when the old focus went away', () => {
    function Screen() {
      const route = useBrowserRoute();
      return (
        <div className="page-viewport">
          <main data-testid="main">{route === '/' && <button>old</button>}</main>
        </div>
      );
    }
    render(<Screen />);
    screen.getByText('old').focus();
    act(() => navigateTo('/compressor'));
    expect(document.activeElement).toBe(screen.getByTestId('main'));
  });
});

describe('when there is no motion', () => {
  it('swaps instantly under reduced motion', () => {
    const { startViewTransition } = installViewTransitionStub();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    render(<RouteProbe />);
    act(() => navigateTo('/compressor'));
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(screen.getByTestId('route').textContent).toBe('/compressor');
  });

  it('swaps instantly in a hidden tab', () => {
    const { startViewTransition } = installViewTransitionStub();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<RouteProbe />);
    act(() => navigateTo('/compressor'));
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('fades the new content in where the browser has no View Transitions', () => {
    render(<RouteProbe />);
    act(() => navigateTo('/compressor'));
    expect(document.documentElement.dataset.navEnter).toBe('page');
  });
});

describe('cancelled navigations', () => {
  it('stays put and reports the attempt as cancelled', () => {
    render(<RouteProbe />);
    const block = (event: Event) => event.preventDefault();
    window.addEventListener(BEFORE_NAVIGATION_EVENT, block);
    act(() => navigateTo('/compressor'));
    window.removeEventListener(BEFORE_NAVIGATION_EVENT, block);
    expect(location.pathname).toBe('/');
    expect(sent.at(-1)).toMatchObject({
      nav_final: 'cancelled',
      nav_from_screen: 'tools_home',
      nav_to_screen: 'tool'
    });
  });
});

describe('revealing a filled screen', () => {
  function captureUpdate() {
    let done: Promise<unknown> | null = null;
    const startViewTransition = vi.fn((update: () => Promise<unknown> | void) => {
      done = Promise.resolve(update());
      const finished = done.then(() => undefined);
      return {
        finished,
        ready: Promise.resolve(),
        updateCallbackDone: finished,
        skipTransition: vi.fn()
      };
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition
    });
    return () => done;
  }

  function Loading({ route }: { route: string }) {
    return route === '/compressor' ? (
      <div className="page-viewport">
        <span className="ui-skeleton" data-testid="placeholder" />
      </div>
    ) : (
      <div className="page-viewport" />
    );
  }

  function Probe() {
    return <Loading route={useBrowserRoute()} />;
  }

  it('holds the old screen while the new one shows placeholders, then reveals it', async () => {
    vi.useFakeTimers();
    const update = captureUpdate();
    // jsdom lays nothing out; count every node as on screen.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      {}
    ] as unknown as DOMRectList);
    render(<Probe />);
    act(() => navigateTo('/compressor'));
    let revealed = false;
    void update()!.then(() => {
      revealed = true;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(revealed).toBe(false);
    screen.getByTestId('placeholder').remove();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(revealed).toBe(true);
  });

  it('stops holding after the cap even if placeholders stay', async () => {
    vi.useFakeTimers();
    const update = captureUpdate();
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      {}
    ] as unknown as DOMRectList);
    render(<Probe />);
    act(() => navigateTo('/compressor'));
    let revealed = false;
    void update()!.then(() => {
      revealed = true;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_BEFORE_REVEAL_MS + 40);
    });
    expect(revealed).toBe(true);
  });
});
