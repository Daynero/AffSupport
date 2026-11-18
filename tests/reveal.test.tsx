// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Reveal } from '../apps/web/src/components/ui/index';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Content({ onMount }: { onMount?: () => void }) {
  useEffect(() => onMount?.(), [onMount]);
  return <p>cards</p>;
}

function frames() {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return () => act(() => queue.splice(0).forEach(callback => callback(0)));
}

describe('Reveal (058)', () => {
  it('mounts the content while loading, hidden behind the placeholder', () => {
    const mounted = vi.fn();
    render(
      <Reveal busy placeholder={<span>placeholder</span>}>
        <Content onMount={mounted} />
      </Reveal>
    );
    expect(screen.getByText('placeholder')).toBeTruthy();
    expect(mounted).toHaveBeenCalledOnce();
    const box = screen.getByText('cards').parentElement!;
    expect(box.hidden).toBe(true);
    expect(box.getAttribute('aria-busy')).toBe('true');
  });

  it('shows ready content as it is when no placeholder was painted', () => {
    frames();
    const { rerender } = render(
      <Reveal busy placeholder={<span>placeholder</span>}>
        <Content />
      </Reveal>
    );
    rerender(
      <Reveal busy={false} placeholder={<span>placeholder</span>}>
        <Content />
      </Reveal>
    );
    const box = screen.getByText('cards').parentElement!;
    expect(screen.queryByText('placeholder')).toBeNull();
    expect(box.hidden).toBe(false);
    expect(box.classList.contains('is-arriving')).toBe(false);
  });

  it('fades the content in over a placeholder that was on screen, once', () => {
    vi.useFakeTimers();
    const paint = frames();
    const { rerender } = render(
      <Reveal busy placeholder={<span>placeholder</span>}>
        <Content />
      </Reveal>
    );
    paint();
    rerender(
      <Reveal busy={false} placeholder={<span>placeholder</span>}>
        <Content />
      </Reveal>
    );
    const box = screen.getByText('cards').parentElement!;
    expect(box.classList.contains('is-arriving')).toBe(true);
    act(() => void vi.advanceTimersByTime(900));
    expect(box.classList.contains('is-arriving')).toBe(false);
  });
});
