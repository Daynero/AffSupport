// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoneycombField } from '../apps/web/src/components/HoneycombField';

/**
 * The backdrop's crawling sparks kept an idle tab's main thread most of a core
 * busy (QA 1.4.3 round 3: 0.82 s of work per second, no requests). They now
 * run only while someone uses the page: awake on input, asleep after a quiet
 * spell or as soon as the tab is hidden. The CSS runs the animation only under
 * `data-awake`, so the attribute is the contract.
 */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('honeycomb sparks sleep while the page is idle', () => {
  beforeEach(() => {
    // jsdom draws no SVG; the cursor-lift effect only needs the call to exist.
    (SVGElement.prototype as unknown as { getScreenCTM: () => null }).getScreenCTM = () => null;
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const layer = (container: HTMLElement) => container.querySelector('.soty-trace-layer')!;

  it('wakes on mount and sleeps after eight quiet seconds', () => {
    const { container } = render(<HoneycombField />);
    expect(layer(container).hasAttribute('data-awake')).toBe(true);
    act(() => vi.advanceTimersByTime(7999));
    expect(layer(container).hasAttribute('data-awake')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(layer(container).hasAttribute('data-awake')).toBe(false);
  });

  it('wakes again on input and stays awake while input continues', () => {
    const { container } = render(<HoneycombField />);
    act(() => vi.advanceTimersByTime(9000));
    expect(layer(container).hasAttribute('data-awake')).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('keydown'));
    });
    expect(layer(container).hasAttribute('data-awake')).toBe(true);
    for (let i = 0; i < 5; i++) {
      act(() => vi.advanceTimersByTime(5000));
      act(() => {
        window.dispatchEvent(new Event('pointermove'));
      });
    }
    expect(layer(container).hasAttribute('data-awake')).toBe(true);
  });

  it('sleeps at once when the tab is hidden and wakes when it returns', () => {
    const { container } = render(<HoneycombField />);
    act(() => setHidden(true));
    expect(layer(container).hasAttribute('data-awake')).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('pointermove'));
    });
    expect(layer(container).hasAttribute('data-awake')).toBe(false);
    act(() => setHidden(false));
    expect(layer(container).hasAttribute('data-awake')).toBe(true);
  });
});
