// @vitest-environment jsdom
import React, { useLayoutEffect, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeforeChange } from '../apps/web/src/lib/before-change';
import { moveFromPlaces, rememberPlaces } from '../apps/web/src/lib/layout-move';

type Move = { node: Element; from: string; to: string };
const moves: Move[] = [];
/** Where each thing stands; jsdom lays nothing out, so the test says. */
const places = new Map<Element, { left: number; top: number }>();

const rectOf = (node: Element) => {
  const place = places.get(node) ?? { left: 0, top: 0 };
  return new DOMRect(place.left, place.top, 100, 40);
};

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(this: Element, frames: Array<{ translate: string }>) {
      moves.push({ node: this, from: frames[0]!.translate, to: frames[1]!.translate });
      return { finished: new Promise<void>(() => {}), cancel: () => {} };
    }
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return rectOf(this);
  };
});

beforeEach(() => {
  moves.length = 0;
  places.clear();
});

afterEach(() => {
  document.documentElement.className = '';
  cleanup();
  vi.unstubAllGlobals();
});

function List() {
  return (
    <div data-testid="list">
      <section data-testid="block" className="mover">
        <p data-testid="first" className="mover">
          one
        </p>
        <p data-testid="second" className="mover">
          two
        </p>
      </section>
    </div>
  );
}

const put = (id: string, left: number, top: number) =>
  places.set(screen.getByTestId(id), { left, top });

describe('things moved by a change of layout (058)', () => {
  it('starts a thing from where it stood and lets it travel to where it stands', () => {
    render(<List />);
    put('first', 300, 100);
    rememberPlaces(screen.getByTestId('list'), '.mover');
    // The list narrowed: the tile is now a row lower, at the left.
    put('first', 0, 140);
    expect(moveFromPlaces(screen.getByTestId('list'))).toBe(1);
    expect(moves).toEqual([
      { node: screen.getByTestId('first'), from: '300px -40px', to: '0px 0px' }
    ]);
  });

  it('gives a thing inside one that moves only the rest of its own way', () => {
    render(<List />);
    put('block', 0, 100);
    put('first', 0, 100);
    put('second', 200, 100);
    rememberPlaces(screen.getByTestId('list'), '.mover');
    // A note above grew by a line: the block is 24 lower, and with it everything in it. The
    // second also came 80 closer — its column closed up.
    put('block', 0, 124);
    put('first', 0, 124);
    put('second', 120, 124);
    expect(moveFromPlaces(screen.getByTestId('list'))).toBe(2);
    expect(moves).toEqual([
      { node: screen.getByTestId('block'), from: '0px -24px', to: '0px 0px' },
      { node: screen.getByTestId('second'), from: '80px 0px', to: '0px 0px' }
    ]);
  });

  it('moves nothing that did not move, and nothing twice', () => {
    render(<List />);
    put('first', 10, 10);
    rememberPlaces(screen.getByTestId('list'), '.mover');
    expect(moveFromPlaces(screen.getByTestId('list'))).toBe(0);
    // The memory is spent: a later change is not played against it.
    put('first', 90, 10);
    expect(moveFromPlaces(screen.getByTestId('list'))).toBe(0);
    expect(moves).toHaveLength(0);
  });

  it('leaves alone what is off screen at both ends', () => {
    render(<List />);
    put('first', 0, 5000);
    rememberPlaces(screen.getByTestId('list'), '.mover');
    put('first', 0, 5200);
    expect(moveFromPlaces(screen.getByTestId('list'))).toBe(0);
  });

  it('does nothing under reduced motion, or while the whole screen is in transition', () => {
    render(<List />);
    put('first', 300, 100);
    document.documentElement.classList.add('wishly-section-transition');
    rememberPlaces(screen.getByTestId('list'), '.mover');
    put('first', 0, 140);
    expect(moveFromPlaces(screen.getByTestId('list'))).toBe(0);
    document.documentElement.className = '';

    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    put('first', 300, 100);
    rememberPlaces(screen.getByTestId('list'), '.mover');
    put('first', 0, 140);
    expect(moveFromPlaces(screen.getByTestId('list'))).toBe(0);
    expect(moves).toHaveLength(0);
  });
});

describe('BeforeChange (058)', () => {
  it('runs while the page still shows the old state, and not on mount', () => {
    const seen: string[] = [];
    function Card() {
      const [name, setName] = useState('one');
      const ref = useRef<HTMLParagraphElement>(null);
      const after = useRef<string[]>([]);
      useLayoutEffect(() => {
        after.current.push(ref.current!.textContent!);
      });
      return (
        <div>
          <BeforeChange of={name} run={() => seen.push(ref.current!.textContent!)} />
          <p ref={ref}>{name}</p>
          <button onClick={() => setName('two')}>next</button>
          <button onClick={() => setName('two')}>same</button>
        </div>
      );
    }
    render(<Card />);
    expect(seen).toEqual([]);
    fireEvent.click(screen.getByText('next'));
    // Called with the old words still in the page; the page has them changed afterwards.
    expect(seen).toEqual(['one']);
    expect(screen.getByText('two')).toBeTruthy();
    fireEvent.click(screen.getByText('same'));
    expect(seen).toEqual(['one']);
  });
});
