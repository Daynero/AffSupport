// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AGENT_TOOL_CONTRACTS,
  POWER_LIMIT_MAX,
  SOTY_LOAD_CHANNEL,
  sotyLoadFrom,
  type PowerActivity,
  type PowerState,
  type SotyLoad,
  type ToolContracts
} from '../packages/shared/src/types';
import { AgentContextOverride } from '../apps/web/src/AgentContext';
import { PowerContextOverride, type PowerContextValue } from '../apps/web/src/lib/power';
import { PowerThrottle } from '../apps/web/src/components/PowerThrottle';
import { loadBands, loadHeat } from '../apps/web/src/components/PowerLoadMeter';
import { fakeAgentValue } from './support/fake-agent';

/**
 * The header power button shows how hard Soty itself is working the computer: bands, a
 * figure and a shrunk bolt while it is; the plain bolt while it is not, or while no agent
 * says. The panel's sentence is built from the same reading, so the two never disagree.
 *
 * The real hook runs here; only the stream is faked, so what is tested is what an agent's
 * contract and its messages actually do to the button.
 */

const streams = vi.hoisted(() => ({
  byChannel: new Map<string, { enabled: boolean; onMessage: (event: unknown) => void }>()
}));

vi.mock('../apps/web/src/api/useAgentEventStream', () => ({
  useAgentEventStream: (input: {
    channel?: string;
    enabled: boolean;
    onMessage: (event: unknown) => void;
  }) => {
    if (input.channel) streams.byChannel.set(input.channel, input);
  }
}));
vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

beforeEach(() => {
  streams.byChannel.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const POWER: PowerState = {
  limitPercent: POWER_LIMIT_MAX,
  mode: 'unrestricted',
  sample: {
    // What 1.7.2 put under the button: the throttle's own figure, CPU only.
    availability: 'ok',
    systemSharePercent: 0,
    graphicsSharePercent: null,
    activity: 'idle',
    cpuCount: 8,
    sampledAt: '2026-11-25T10:00:00.000Z'
  },
  throttlingSupported: true,
  holdingToLimit: false,
  activeChildren: 0,
  updatedAt: '2026-11-25T10:00:00.000Z'
};

function powerValue(limitPercent = POWER_LIMIT_MAX): PowerContextValue {
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

function reading(
  cpu: number,
  gpu: number | null,
  at = '1',
  activity: PowerActivity = cpu > 0 || (gpu ?? 0) > 0 ? 'active' : 'idle'
): SotyLoad {
  return sotyLoadFrom({ cpuPercent: cpu, gpuPercent: gpu, activity, sampledAt: at });
}

const CURRENT: ToolContracts = { ...AGENT_TOOL_CONTRACTS };
/** 1.7.2: the same channel, carrying the whole computer's load. */
const WHOLE_MACHINE: ToolContracts = { ...AGENT_TOOL_CONTRACTS, machineLoad: 1 };

function renderButton(
  options: { contracts?: ToolContracts | null; limitPercent?: number; stream?: boolean } = {}
) {
  const limitPercent = options.limitPercent ?? POWER_LIMIT_MAX;
  const panel = (
    <PowerContextOverride value={powerValue(limitPercent)}>
      <PowerThrottle />
    </PowerContextOverride>
  );
  render(
    options.contracts === null ? (
      panel
    ) : (
      <AgentContextOverride
        value={fakeAgentValue({
          capabilities: options.stream === false ? [] : ['event-stream'],
          toolContracts: options.contracts ?? CURRENT
        })}
      >
        {panel}
      </AgentContextOverride>
    )
  );
  const button = () => screen.getByRole('button', { name: /power limit/i });
  const send = (load: SotyLoad) =>
    act(() => {
      streams.byChannel.get(SOTY_LOAD_CHANNEL)?.onMessage(load);
    });
  const figure = () => button().querySelector('.power-toggle__load')?.textContent;
  const openPanel = () => userEvent.setup().click(button());
  const line = () => document.querySelector('.power-readout')?.textContent;
  return { button, send, figure, openPanel, line };
}

describe('load meter on the power button', () => {
  it('is the plain bolt when no agent is connected', () => {
    const { button } = renderButton({ contracts: null });
    expect(button().getAttribute('data-meter')).toBeNull();
    expect(button().getAttribute('title')).toMatch(/up to 100%/i);
  });

  it('is the plain bolt while Soty is doing nothing, tooltip included', () => {
    const { button, send } = renderButton();
    send(reading(0, 0));
    expect(button().getAttribute('data-meter')).toBeNull();
    expect(button().getAttribute('title')).toMatch(/up to 100%/i);
  });

  it('shows the figure once Soty is working, with both halves in the tooltip', () => {
    const { button, send, figure } = renderButton();
    send(reading(47, 12));
    expect(button().getAttribute('data-meter')).toBe('on');
    expect(figure()).toBe('47%');
    expect(button().getAttribute('title')).toBe('Soty load: CPU 47% · GPU 12% · Power limit: 100%');
  });

  it('follows the graphics when they are the busier of the two', () => {
    const { send, figure } = renderButton();
    send(reading(1, 81));
    expect(figure()).toBe('81%');
  });

  it('leaves the graphics out of the tooltip where they cannot be attributed', () => {
    const { button, send } = renderButton({ limitPercent: 60 });
    send(reading(30, null));
    expect(button().getAttribute('title')).toBe('Soty load: CPU 30% · Power limit: 60%');
  });

  it('does not blink on and off at the edge of idle', () => {
    const { button, send } = renderButton();
    send(reading(2, null, 'a'));
    expect(button().getAttribute('data-meter')).toBe('on');
    send(reading(1, null, 'b'));
    expect(button().getAttribute('data-meter')).toBe('on');
    send(reading(0, null, 'c'));
    expect(button().getAttribute('data-meter')).toBeNull();
    send(reading(1, null, 'd'));
    expect(button().getAttribute('data-meter')).toBeNull();
  });

  it('goes back to the bolt when the agent has no figure', () => {
    const { button, send } = renderButton();
    send(reading(55, null));
    send({ availability: 'warming-up', sampledAt: 'x' });
    expect(button().getAttribute('data-meter')).toBeNull();
  });

  it('never shows the whole-machine figure an older agent publishes', () => {
    const { button, send } = renderButton({ contracts: WHOLE_MACHINE });
    // 1.7.2 on the same channel: a browser's load, which is not Soty's.
    expect(streams.byChannel.get(SOTY_LOAD_CHANNEL)?.enabled).toBe(false);
    send(reading(15, 40));
    expect(button().getAttribute('data-meter')).toBeNull();
    expect(button().getAttribute('title')).toMatch(/up to 100%/i);
  });

  it('is the plain bolt for an agent without the multiplexed stream', () => {
    const { button, send } = renderButton({ stream: false });
    send(reading(47, null));
    expect(button().getAttribute('data-meter')).toBeNull();
  });

  it('never hides the figure from assistive technology behind the meter', () => {
    const { button, send } = renderButton();
    send(reading(47, null));
    expect(button().querySelector('.power-meter')?.getAttribute('aria-hidden')).toBe('true');
    expect(button().getAttribute('aria-label')).toMatch(/power limit/i);
  });
});

describe('the panel line agrees with the button', () => {
  it('says Soty is idle, with no figure, under the plain bolt', async () => {
    const { button, send, openPanel, line } = renderButton();
    send(reading(0, 0, '1', 'idle'));
    await openPanel();
    expect(button().getAttribute('data-meter')).toBeNull();
    expect(line()).toBe('Soty is idle');
  });

  it('says Soty is working but barely, when it is and the button is still the bolt', async () => {
    const { send, openPanel, line } = renderButton();
    send(reading(0, 0, '1', 'active'));
    await openPanel();
    expect(line()).toBe('Soty is working, barely loading this computer');
  });

  it('gives the very figure the button shows, and what it is made of', async () => {
    const { send, openPanel, line, figure } = renderButton();
    send(reading(15, 3));
    await openPanel();
    expect(figure()).toBe('15%');
    expect(line()).toBe('Soty is using 15% of this computer · processor 15% · graphics 3%');
  });

  it('does not split the figure where only the processor can be measured', async () => {
    const { send, openPanel, line } = renderButton();
    send(reading(15, null));
    await openPanel();
    expect(line()).toBe('Soty is using 15% of this computer');
  });

  it("measures, rather than falling back to the throttle's figure, while the reading warms up", async () => {
    const { openPanel, line } = renderButton();
    await openPanel();
    expect(line()).toBe('Measuring…');
  });

  it('keeps the throttle sentence for an older agent, whose button is the bolt', async () => {
    const { send, openPanel, line, button } = renderButton({ contracts: WHOLE_MACHINE });
    send(reading(15, 40));
    await openPanel();
    expect(button().getAttribute('data-meter')).toBeNull();
    expect(line()).toBe('Soty is idle — 0.0%');
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
    expect(Math.min(...loadBands(2, 0))).toBeGreaterThan(0);
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
