// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { useAgentEventStream } from '../apps/web/src/api/useAgentEventStream';

/**
 * FR-033 / FR-034 / SC-012. A brief interruption has to look like a brief
 * interruption.
 *
 * The audit found the opposite: a dropped stream propagated straight to the
 * interface, the tool page unmounted, and a user who had been working for
 * twenty minutes was offered instructions for installing the application they
 * were already running. Two seconds of wifi handover produced a screen that
 * read as a broken install.
 *
 * These assertions are about the boundary, not the pixels: what the interface
 * is *told*, and when.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  /** The transport failing, as a lid closing or a wifi handover produces. */
  fail() {
    this.onerror?.();
  }
}

function Subject({ onDisconnect }: { onDisconnect: () => void }) {
  const [messages] = useState(0);
  useAgentEventStream<{ ok: boolean }>({
    url: 'http://127.0.0.1:43140/api/events',
    enabled: true,
    onMessage: () => {},
    onDisconnect
  });
  return <div data-testid="page">mounted {messages}</div>;
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a short interruption', () => {
  it('is never reported to the interface', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    const onDisconnect = vi.fn();
    render(<Subject onDisconnect={onDisconnect} />);

    act(() => FakeEventSource.instances[0].fail());
    // Two seconds: a wifi handover, a lid, the agent finishing a write.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onDisconnect).not.toHaveBeenCalled();

    // And it recovers before the grace expires, so it is never reported at all.
    act(() => {
      vi.advanceTimersByTime(500);
      FakeEventSource.instances.at(-1)?.onopen?.();
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('leaves the page mounted throughout', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    render(<Subject onDisconnect={() => {}} />);

    act(() => FakeEventSource.instances[0].fail());
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    // Unmounting here is what threw away form input and scroll position.
    expect(screen.getByTestId('page')).toBeTruthy();
  });
});

describe('an interruption that outlives the grace', () => {
  it('is reported once, not once per retry', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    const onDisconnect = vi.fn();
    render(<Subject onDisconnect={onDisconnect} />);

    act(() => FakeEventSource.instances[0].fail());
    act(() => {
      vi.advanceTimersByTime(3_500);
    });
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // Every retry from here also fails; the interface has already been told.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      act(() => {
        vi.advanceTimersByTime(20_000);
        FakeEventSource.instances.at(-1)?.fail();
      });
    }
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('backs off rather than reconnecting at full speed', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    render(<Subject onDisconnect={() => {}} />);

    act(() => FakeEventSource.instances[0].fail());
    const opened = () => FakeEventSource.instances.length;
    const afterFirst = opened();

    // A local app that is genuinely down stays down; retrying it several times
    // a second for as long as the tab is open is how a laptop stays warm.
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(opened()).toBe(afterFirst + 1);
    act(() => FakeEventSource.instances.at(-1)?.fail());
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    // The second delay is longer than the first, so this retry has not happened yet.
    expect(opened()).toBe(afterFirst + 1);
  });
});
