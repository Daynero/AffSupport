// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useLaunchProgressScroll } from '../apps/web/src/team/launches/useLaunchProgressScroll';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function Host({ stage }: { stage: string }) {
  const scroll = useLaunchProgressScroll();
  return (
    <div ref={scroll.anchor}>
      <span>{stage}</span>
      <button onClick={scroll.reveal}>Generate</button>
    </div>
  );
}
it.each([false, true])(
  'scrolls once after a user action, respecting reduced motion (%s)',
  async reduced => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    try {
      const view = render(<Host stage="Preparation" />);
      expect(scroll).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(scroll).toHaveBeenCalledExactlyOnceWith({
        behavior: reduced ? 'auto' : 'smooth',
        block: 'start'
      });
      view.rerender(<Host stage="Video" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(scroll).toHaveBeenCalledOnce();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  }
);
