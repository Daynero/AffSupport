// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  POWER_LIMIT_MAX,
  POWER_LIMIT_MIN,
  type PowerSample,
  type PowerState
} from '../packages/shared/src/types';
import { PowerContextOverride, type PowerContextValue } from '../apps/web/src/lib/power';
import { PowerThrottle } from '../apps/web/src/components/PowerThrottle';

vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stateWith(sample: PowerSample, limitPercent = POWER_LIMIT_MAX): PowerState {
  return {
    limitPercent,
    mode: limitPercent >= POWER_LIMIT_MAX ? 'unrestricted' : 'limited',
    sample,
    throttlingSupported: true,
    activeChildren: sample.activity === 'active' ? 1 : 0,
    updatedAt: '2026-08-20T09:00:00.000Z'
  };
}

function renderPanel(overrides: Partial<PowerContextValue> = {}) {
  const setLimit = vi.fn();
  const teardown = vi.fn();
  const watch = vi.fn(() => teardown);
  const value: PowerContextValue = {
    state: stateWith({
      availability: 'ok',
      systemSharePercent: 38.4,
      activity: 'active',
      cpuCount: 10,
      sampledAt: '2026-08-20T09:00:00.000Z'
    }),
    status: 'ready',
    limitPercent: POWER_LIMIT_MAX,
    setLimit,
    watch,
    error: null,
    limitApplied: true,
    ...overrides
  };
  render(
    <PowerContextOverride value={value}>
      <PowerThrottle />
    </PowerContextOverride>
  );
  return { setLimit, watch, teardown };
}

describe('header control', () => {
  it('renders a labelled, collapsed button', () => {
    renderPanel();
    const button = screen.getByRole('button', { name: /power limit/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('shows nothing special while unrestricted', () => {
    renderPanel();
    const button = screen.getByRole('button', { name: /power limit/i });
    expect(button.getAttribute('data-limited')).toBeNull();
  });

  it('flags a reduced limit without the panel being opened', () => {
    // A limit set weeks ago must not read as "Soty has become slow".
    renderPanel({ limitPercent: 40 });
    const button = screen.getByRole('button', { name: /power limit/i });
    expect(button.getAttribute('data-limited')).toBe('true');
    expect(within(button).getByText('40')).toBeTruthy();
  });

  it('opens and closes on the button', async () => {
    const user = userEvent.setup();
    const { watch, teardown } = renderPanel();
    const button = screen.getByRole('button', { name: /power limit/i });

    await user.click(button);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Measurement is refcounted to the open panel on both sides of the wire.
    expect(watch).toHaveBeenCalled();

    await user.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(teardown).toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the button', async () => {
    const user = userEvent.setup();
    renderPanel();
    const button = screen.getByRole('button', { name: /power limit/i });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('the lever', () => {
  async function openLever(overrides: Partial<PowerContextValue> = {}) {
    const user = userEvent.setup();
    const handles = renderPanel(overrides);
    await user.click(screen.getByRole('button', { name: /power limit/i }));
    return { user, slider: screen.getByRole('slider'), ...handles };
  }

  it('exposes itself as a vertical slider with its bounds', async () => {
    const { slider } = await openLever({ limitPercent: 40 });
    expect(slider.getAttribute('aria-orientation')).toBe('vertical');
    expect(slider.getAttribute('aria-valuemin')).toBe(String(POWER_LIMIT_MIN));
    expect(slider.getAttribute('aria-valuemax')).toBe(String(POWER_LIMIT_MAX));
    expect(slider.getAttribute('aria-valuenow')).toBe('40');
    expect(slider.getAttribute('aria-valuetext')).toBe('40%');
  });

  it('steps by one on the arrow keys', async () => {
    const { user, slider, setLimit } = await openLever({ limitPercent: 40 });
    slider.focus();
    await user.keyboard('{ArrowUp}');
    expect(setLimit).toHaveBeenLastCalledWith(41);
    await user.keyboard('{ArrowDown}');
    expect(setLimit).toHaveBeenLastCalledWith(39);
  });

  it('steps by ten on Page Up and Page Down', async () => {
    const { user, slider, setLimit } = await openLever({ limitPercent: 40 });
    slider.focus();
    await user.keyboard('{PageUp}');
    expect(setLimit).toHaveBeenLastCalledWith(50);
    await user.keyboard('{PageDown}');
    expect(setLimit).toHaveBeenLastCalledWith(30);
  });

  it('jumps to the bounds on Home and End', async () => {
    const { user, slider, setLimit } = await openLever({ limitPercent: 40 });
    slider.focus();
    await user.keyboard('{Home}');
    expect(setLimit).toHaveBeenLastCalledWith(POWER_LIMIT_MIN);
    await user.keyboard('{End}');
    expect(setLimit).toHaveBeenLastCalledWith(POWER_LIMIT_MAX);
  });

  it('never proposes a value outside the bounds', async () => {
    const { user, slider, setLimit } = await openLever({ limitPercent: POWER_LIMIT_MAX });
    slider.focus();
    await user.keyboard('{ArrowUp}');
    expect(setLimit).toHaveBeenLastCalledWith(POWER_LIMIT_MAX);
  });

  it('is not reachable by keyboard when the agent cannot honour it', async () => {
    const { slider } = await openLever({ status: 'unsupported' });
    expect(slider.getAttribute('aria-disabled')).toBe('true');
    expect(slider.getAttribute('tabindex')).toBe('-1');
  });
});

describe('the readout', () => {
  async function openWith(overrides: Partial<PowerContextValue>) {
    const user = userEvent.setup();
    renderPanel(overrides);
    await user.click(screen.getByRole('button', { name: /power limit/i }));
    return screen.getByRole('dialog');
  }

  it('reports the share while work is running', async () => {
    const dialog = await openWith({});
    expect(dialog.textContent).toContain('38.4');
  });

  it('reports idle without pretending nothing is measurable', async () => {
    const dialog = await openWith({
      state: stateWith({
        availability: 'ok',
        systemSharePercent: 0.2,
        activity: 'idle',
        cpuCount: 10,
        sampledAt: '2026-08-20T09:00:00.000Z'
      })
    });
    expect(dialog.textContent).toContain('idle');
    expect(dialog.textContent).toContain('0.2');
  });

  it.each(['warming-up', 'unsupported', 'error'] as const)(
    'shows no percentage at all when the sample is %s',
    async availability => {
      const dialog = await openWith({
        state: stateWith({
          availability,
          activity: 'idle',
          cpuCount: 10,
          sampledAt: '2026-08-20T09:00:00.000Z'
        })
      });
      // Scoped to the readout: the panel legitimately shows the *limit* as a
      // percentage. What must never appear is a *consumption* figure that does
      // not exist — "unavailable" and "0%" are different claims, and rendering
      // the second would read a stalled agent as an idle one.
      const readout = dialog.querySelector('[aria-live]');
      expect(readout?.textContent).not.toMatch(/\d+(\.\d+)?%/);
    }
  );

  it('explains an offline agent instead of showing a stale figure', async () => {
    const dialog = await openWith({ status: 'offline', state: null });
    const readout = dialog.querySelector('[aria-live]');
    expect(readout?.textContent).toMatch(/not running/i);
    expect(readout?.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });

  it('points at an update when the agent predates the feature', async () => {
    const dialog = await openWith({ status: 'unsupported', state: null });
    expect(dialog.textContent).toMatch(/update/i);
  });

  it('warns when the host cannot hold running work to the limit', async () => {
    const dialog = await openWith({
      state: {
        ...stateWith({
          availability: 'ok',
          systemSharePercent: 10,
          activity: 'active',
          cpuCount: 10,
          sampledAt: '2026-08-20T09:00:00.000Z'
        }),
        throttlingSupported: false
      }
    });
    expect(dialog.textContent).toMatch(/started from now on/i);
  });

  it('surfaces a limit that could not be applied', async () => {
    const dialog = await openWith({ error: 'POWER_PERSIST_FAILED' });
    expect(dialog.textContent).toMatch(/could not apply/i);
  });
});

describe('a limit that could not be applied', () => {
  async function openPanel(overrides: Partial<PowerContextValue>) {
    const user = userEvent.setup();
    renderPanel(overrides);
    await user.click(screen.getByRole('button', { name: /power limit/i }));
  }

  it('says the value is held rather than in force', async () => {
    // D9. The lever moves the instant it is dragged, which is right while an
    // agent is there to accept the value and misleading when there is not: the
    // panel would otherwise show a number nothing is honouring.
    await openPanel({ limitApplied: false, limitPercent: 40 });
    expect(screen.getByText(/not in force|не діє/iu)).toBeTruthy();
  });

  it('says nothing of the kind once the limit is in force', async () => {
    await openPanel({ limitApplied: true, limitPercent: 40 });
    expect(screen.queryByText(/not in force|не діє/iu)).toBeNull();
  });

  it('lets a real failure speak instead of the held note', async () => {
    // Both at once would be two explanations for one thing; a failed attempt is
    // the more specific claim and wins.
    await openPanel({ limitApplied: false, error: 'POWER_LIMIT_FAILED', limitPercent: 40 });
    expect(screen.queryByText(/not in force|не діє/iu)).toBeNull();
  });
});
