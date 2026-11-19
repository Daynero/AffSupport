// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  crossfadePart,
  dropAutoGhost,
  installAutoCrossfade,
  leaveCopy
} from '../apps/web/src/lib/auto-crossfade';

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
  document.documentElement.className = '';
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

  describe('one part of a screen', () => {
    function Explorer() {
      const [folder, setFolder] = useState('st');
      return (
        <div className="page-viewport">
          <main>
            <nav data-testid="tree">{folder}</nav>
            <div data-testid="list">
              <p>{folder} files</p>
            </div>
            <aside data-testid="pane">card</aside>
            <button data-testid="go" onClick={() => setFolder('vid')} />
          </main>
        </div>
      );
    }

    it('copies only the part named, and puts the copy right after it', () => {
      render(<Explorer />);
      const list = screen.getByTestId('list');
      expect(crossfadePart(list)).toBe(true);
      fireEvent.click(screen.getByTestId('go'));

      const copy = ghost()!;
      // The list as it was; the tree beside it has already answered.
      expect(copy.textContent).toBe('st files');
      expect(copy.classList.contains('is-part')).toBe(true);
      expect(screen.getByTestId('tree').textContent).toBe('vid');
      expect(list.textContent).toBe('vid files');
      // Under whatever comes after the part — the card stays over the copy.
      expect(list.nextElementSibling).toBe(copy);
      expect(copy.nextElementSibling).toBe(screen.getByTestId('pane'));
    });

    it('leaves an older copy in charge when asked to keep it', () => {
      render(<Explorer />);
      const list = screen.getByTestId('list');
      crossfadePart(list);
      fireEvent.click(screen.getByTestId('go'));
      // The pane leaving with the folder asks too: the copy of the old folder is the one to keep.
      expect(crossfadePart(list, { keep: true })).toBe(true);
      const copies = document.querySelectorAll('[data-auto-ghost]');
      expect(copies).toHaveLength(1);
      expect(copies[0]!.textContent).toBe('st files');
    });

    it('does not wait for data when the change is one of layout', async () => {
      render(
        <div className="page-viewport">
          <main>
            <div data-testid="list">
              <span className="ui-skeleton" />
            </div>
          </main>
        </div>
      );
      crossfadePart(screen.getByTestId('list'), { brief: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(80);
      });
      // Fading already, with the placeholder still up — and no second copy behind it.
      expect(animations).toHaveLength(1);
      expect(document.querySelectorAll('[data-auto-ghost]')).toHaveLength(1);
    });

    it('says when it laid nothing, so the caller can fall back to a transition', () => {
      render(<Explorer />);
      expect(crossfadePart(null)).toBe(false);
      document.documentElement.classList.add('wishly-section-transition');
      expect(crossfadePart(screen.getByTestId('list'))).toBe(false);
      expect(ghost()).toBeNull();
    });

    it('leaves a copy of a part that is unmounted, wearing its leaving class', async () => {
      render(<Explorer />);
      const pane = screen.getByTestId('pane');
      leaveCopy(pane, 'is-leaving');
      const copy = pane.nextElementSibling as HTMLElement;
      expect(copy.classList.contains('auto-leaving')).toBe(true);
      expect(copy.classList.contains('is-leaving')).toBe(true);
      expect(copy.hasAttribute('inert')).toBe(true);
      expect(copy.dataset.testid).toBeUndefined();
      // Gone when its motion ends — or, failing that, after a moment.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(copy.isConnected).toBe(false);
    });
  });
});
