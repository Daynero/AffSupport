// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropAutoGhost, installAutoCrossfade } from '../apps/web/src/lib/auto-crossfade';

type FakeAnimation = { finished: Promise<void>; cancel: () => void; finish: () => void };
const animations: FakeAnimation[] = [];

beforeAll(() => {
  // jsdom has no Web Animations; the copy is only made where it can be faded.
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value() {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => {
        finish = resolve;
      });
      const animation = { finished, cancel: () => {}, finish };
      animations.push(animation);
      return animation;
    }
  });
  installAutoCrossfade();
});

beforeEach(() => {
  vi.useFakeTimers();
  animations.length = 0;
});

afterEach(() => {
  dropAutoGhost();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Board() {
  const [filter, setFilter] = useState('all');
  return (
    <div className="page-viewport">
      <main>
        <button aria-pressed={filter === 'free'} onClick={() => setFilter('free')}>
          Free
        </button>
        <button onClick={() => setFilter('saved')}>Save</button>
        <a href="/elsewhere" aria-pressed="false" onClick={event => event.preventDefault()}>
          Elsewhere
        </a>
        <input aria-label="Search" defaultValue="" />
        <p data-testid="list">{filter}</p>
      </main>
    </div>
  );
}

const ghost = () => document.querySelector<HTMLElement>('[data-auto-ghost]');

describe('auto crossfade (058)', () => {
  it('lays a copy of the old state over the screen when a filter is pressed', () => {
    render(<Board />);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'geo' } });
    fireEvent.click(screen.getByText('Free'));

    const copy = ghost();
    expect(copy).not.toBeNull();
    // The copy is what was there: the old list, and what had been typed.
    expect(copy!.querySelector('p')!.textContent).toBe('all');
    expect(copy!.querySelector('input')!.value).toBe('geo');
    expect(copy!.getAttribute('aria-hidden')).toBe('true');
    expect(copy!.hasAttribute('inert')).toBe(true);
    // The live screen under it has moved on.
    expect(screen.getByTestId('list').textContent).toBe('free');
  });

  it('fades the copy once the screen is quiet, and removes it', async () => {
    render(<Board />);
    fireEvent.click(screen.getByText('Free'));
    expect(animations).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(animations).toHaveLength(1);
    animations[0]!.finish();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(ghost()).toBeNull();
  });

  it('dissolves through the in-between state when the answer is late', async () => {
    function Slow() {
      const [state, setState] = useState<'old' | 'loading' | 'new'>('old');
      return (
        <div className="page-viewport">
          <main>
            <button aria-pressed={state !== 'old'} onClick={() => setState('loading')}>
              Filter
            </button>
            <button data-testid="answer" onClick={() => setState('new')} />
            {state === 'loading' ? (
              <span className="ui-skeleton" />
            ) : (
              <p data-testid="rows">{state}</p>
            )}
          </main>
        </div>
      );
    }
    render(<Slow />);
    fireEvent.click(screen.getByText('Filter'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    // The hold ran out with the placeholder still up: the old screen fades into a copy of it.
    const copies = [...document.querySelectorAll<HTMLElement>('[data-auto-ghost]')];
    expect(copies).toHaveLength(2);
    expect(copies[0]!.querySelector('.ui-skeleton')).not.toBeNull();
    expect(copies[1]!.querySelector('p')!.textContent).toBe('old');
    expect(animations).toHaveLength(1);

    // The answer lands; the copy of the placeholder fades into it.
    fireEvent.click(screen.getByTestId('answer'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(animations).toHaveLength(2);
  });

  it('leaves a plain action and a link alone', () => {
    render(<Board />);
    fireEvent.click(screen.getByText('Save'));
    expect(ghost()).toBeNull();
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(ghost()).toBeNull();
  });

  it('copies nothing under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    render(<Board />);
    fireEvent.click(screen.getByText('Free'));
    expect(ghost()).toBeNull();
  });

  it('steps aside at once for a transition that takes the change over', () => {
    render(<Board />);
    fireEvent.click(screen.getByText('Free'));
    expect(ghost()).not.toBeNull();
    dropAutoGhost();
    expect(ghost()).toBeNull();
  });

  it('honours an opt-out', () => {
    render(
      <div className="page-viewport">
        <main data-crossfade="off">
          <button aria-pressed="false">Toggle</button>
        </main>
      </div>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(ghost()).toBeNull();
  });
});
