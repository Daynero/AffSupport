// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { JobRow } from '../apps/web/src/components/JobRow';
import { makeJob } from './helpers.js';
import type { CompressionJob } from '@video-compressor/shared';

/**
 * D6 / FR-036. An animation is a claim.
 *
 * A flowing progress bar says "work is happening right now", and a ticking
 * elapsed timer says "and it has been happening for this long". While the local
 * app is unreachable the interface knows neither of those things — the job may
 * have finished, failed, or still be going — so continuing to animate is not
 * optimism, it is an assertion nobody can check. The last known value, held
 * still, is the honest version.
 */

function processingJob(overrides: Partial<CompressionJob> = {}): CompressionJob {
  return makeJob('job-1', 'processing', {
    fileName: 'holiday.mov',
    progress: 42,
    startedAt: Date.now() - 30_000,
    ...overrides
  });
}

const noop = () => {};
const translate = ((key: string) => key) as never;

function renderRow(connected: boolean) {
  return render(
    <JobRow
      job={processingJob()}
      selected={false}
      disabled={false}
      compressionRunning
      language="en"
      onSelected={noop}
      action={noop}
      t={translate}
      connected={connected}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('while the local app is unreachable', () => {
  it('stops flowing the progress bar', () => {
    const { container } = renderRow(false);
    // The flowing state is a class on the bar, so its absence is observable
    // without reaching into implementation detail about how it animates.
    const active = container.querySelector('.progress-bar.is-active, [data-active="true"]');
    expect(active).toBeNull();
  });

  it('keeps flowing it while connected', () => {
    const { container } = renderRow(true);
    const bar = container.querySelector('.job-progress');
    expect(bar).toBeTruthy();
  });

  it('holds the last known percentage rather than resetting it', () => {
    renderRow(false);
    // Zeroing a job that is very likely still running would be a worse lie than
    // a stale number, and would look like the work was lost.
    expect(screen.getByText('42%')).toBeTruthy();
  });

  it('schedules no second-by-second tick, where a connected row does', () => {
    // Counted relatively rather than absolutely: other effects in the row use
    // timers too, so what matters is that the one-second elapsed tick is the
    // difference between the two renders.
    const ticksFor = (connected: boolean) => {
      const spy = vi.spyOn(window, 'setInterval');
      const view = renderRow(connected);
      const count = spy.mock.calls.filter(([, delay]) => delay === 1000).length;
      view.unmount();
      spy.mockRestore();
      return count;
    };

    const connectedTicks = ticksFor(true);
    const disconnectedTicks = ticksFor(false);
    expect(connectedTicks).toBeGreaterThan(0);
    // While the connection is down the elapsed figure is not a live reading, so
    // it has nothing to count with.
    expect(disconnectedTicks).toBe(0);
  });

  it('resumes ticking when the connection returns', () => {
    const spy = vi.spyOn(window, 'setInterval');
    const view = renderRow(false);
    view.rerender(
      <JobRow
        job={processingJob()}
        selected={false}
        disabled={false}
        compressionRunning
        language="en"
        onSelected={noop}
        action={noop}
        t={translate}
        connected
      />
    );
    expect(spy.mock.calls.filter(([, delay]) => delay === 1000).length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
