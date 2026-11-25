// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  POWER_LIMIT_MAX,
  machineLoadFrom,
  type MachineLoad,
  type PowerState
} from '../packages/shared/src/types';
import { PowerContextOverride, type PowerContextValue } from '../apps/web/src/lib/power';
import { PowerThrottle } from '../apps/web/src/components/PowerThrottle';
import { loadBands, loadHeat } from '../apps/web/src/components/PowerLoadMeter';

/**
 * The header power button shows how busy the computer is: bands, a figure and a shrunk
 * bolt while it is working; the plain bolt while it is idle or no agent says.
 */

const machine = vi.hoisted(() => ({ load: null as MachineLoad | null }));

vi.mock('../apps/web/src/lib/machine-load', () => ({
  useMachineLoad: () => machine.load
}));
vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

beforeEach(() => {
  machine.load = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const POWER: PowerState = {
  limitPercent: POWER_LIMIT_MAX,
  mode: 'unrestricted',
  sample: {
    availability: 'warming-up',
    activity: 'idle',
    cpuCount: 8,
    sampledAt: '2026-11-25T10:00:00.000Z'
  },
  throttlingSupported: true,
  holdingToLimit: false,
  activeChildren: 0,
  updatedAt: '2026-11-25T10:00:00.000Z'
};

function contextValue(limitPercent = POWER_LIMIT_MAX): PowerContextValue {
  return {
    state: { ...POWER, limitPercent },
    status: 'ready',
    limitPercent,
    setLimit: vi.fn(),
    watch: vi.fn(() => () => {}),
    error: null,
    limitApplied: true
  };
}

function reading(cpu: number, gpu: number | null, at = '1'): MachineLoad {
  return machineLoadFrom({ cpuPercent: cpu, gpuPercent: gpu, sampledAt: at });
}

function renderButton(limitPercent = POWER_LIMIT_MAX) {
  const view = render(
    <PowerContextOverride value={contextValue(limitPercent)}>
      <PowerThrottle />
    </PowerContextOverride>
  );
  const button = () => screen.getByRole('button', { name: /power limit/i });
  const rerender = () =>
    view.rerender(
      <PowerContextOverride value={contextValue(limitPercent)}>
        <PowerThrottle />
      </PowerContextOverride>
    );
  return { button, rerender };
}

describe('load meter on the power button', () => {
  it('is the plain bolt when no agent publishes the load', () => {
    const { button } = renderButton();
    expect(button().getAttribute('data-meter')).toBeNull();
    expect(button().getAttribute('title')).toMatch(/up to 100%/i);
  });

  it('is the plain bolt while the computer is idle, but the tooltip still has the figures', () => {
    machine.load = reading(2, 1);
    const { button } = renderButton();
    expect(button().getAttribute('data-meter')).toBeNull();
    expect(button().getAttribute('title')).toBe('Load: CPU 2% · GPU 1% · Power limit: 100%');
  });

  it('shows the larger figure once the computer is working', () => {
    machine.load = reading(47, 12);
    const { button } = renderButton();
    expect(button().getAttribute('data-meter')).toBe('on');
    expect(button().querySelector('.power-toggle__load')?.textContent).toBe('47%');
    expect(button().getAttribute('title')).toBe('Load: CPU 47% · GPU 12% · Power limit: 100%');
  });

  it('follows the graphics when they are the busier of the two', () => {
    machine.load = reading(9, 81);
    const { button } = renderButton();
    expect(button().querySelector('.power-toggle__load')?.textContent).toBe('81%');
  });

  it('leaves the graphics out of the tooltip where they cannot be read', () => {
    machine.load = reading(30, null);
    const { button } = renderButton(60);
    expect(button().getAttribute('title')).toBe('Load: CPU 30% · Power limit: 60%');
  });

  it('does not blink on and off at the edge of idle', () => {
    machine.load = reading(6, null, 'a');
    const { button, rerender } = renderButton();
    expect(button().getAttribute('data-meter')).toBe('on');
    machine.load = reading(4, null, 'b');
    rerender();
    expect(button().getAttribute('data-meter')).toBe('on');
    machine.load = reading(2, null, 'c');
    rerender();
    expect(button().getAttribute('data-meter')).toBeNull();
    machine.load = reading(4, null, 'd');
    rerender();
    expect(button().getAttribute('data-meter')).toBeNull();
  });

  it('goes back to the bolt when the agent stops answering', () => {
    machine.load = reading(55, null);
    const { button, rerender } = renderButton();
    machine.load = { availability: 'warming-up', sampledAt: 'x' };
    rerender();
    expect(button().getAttribute('data-meter')).toBeNull();
  });

  it('never hides the figure from assistive technology behind the meter', () => {
    machine.load = reading(47, null);
    const { button } = renderButton();
    expect(button().querySelector('.power-meter')?.getAttribute('aria-hidden')).toBe('true');
    expect(button().getAttribute('aria-label')).toMatch(/power limit/i);
  });
});

describe('bands', () => {
  it('average to the reading exactly, whatever order they are dealt in', () => {
    for (const beat of [0, 1, 2, 3, 7]) {
      const bands = loadBands(50, beat);
      const mean = bands.reduce((sum, band) => sum + band, 0) / bands.length;
      expect(mean).toBeCloseTo(0.5, 2);
    }
  });

  it('trade places from one reading to the next', () => {
    expect(loadBands(50, 0)).not.toEqual(loadBands(50, 1));
  });

  it('stay inside the button and never vanish while shown', () => {
    expect(Math.max(...loadBands(100, 0))).toBeLessThanOrEqual(1);
    expect(Math.min(...loadBands(5, 0))).toBeGreaterThan(0);
  });
});

describe('colour', () => {
  it('stays calm through ordinary work and warms toward the top', () => {
    expect(loadHeat(20)).toBe(0);
    expect(loadHeat(35)).toBe(0);
    expect(loadHeat(65)).toBeCloseTo(0.5, 2);
    expect(loadHeat(95)).toBe(1);
    expect(loadHeat(100)).toBe(1);
  });
});
