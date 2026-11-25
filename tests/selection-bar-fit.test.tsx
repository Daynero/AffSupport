// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SelectionBar } from '../apps/web/src/components/ui/index';

/*
 * jsdom lays nothing out, so the bar's room is modelled: 300 px wide; the count, the clear
 * button's word and every act's word take 100 px each while they are shown.
 */
const ROOM = 300;
const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

function needed(bar: HTMLElement) {
  const words = [...bar.querySelectorAll<HTMLElement>('.ui-selection-act-label')].filter(
    word => !('bare' in word.dataset)
  );
  return 100 + (bar.dataset.fit === 'tight' ? 0 : 100) + 100 * words.length;
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ui-selection-bar') ? needed(this) : 0;
    }
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ui-selection-bar') ? ROOM : 0;
    }
  });
});

afterAll(() => {
  if (scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth);
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
});

afterEach(cleanup);

function Bar({ acts }: { acts: string[] }) {
  return (
    <SelectionBar
      count={3}
      label="Обрано: 3"
      clearLabel="Скинути вибір (3)"
      onClear={() => {}}
      actions={acts.map(act => (
        <button key={act} type="button" aria-label={act}>
          <span className="ui-selection-act-label">{act}</span>
        </button>
      ))}
    />
  );
}

const bar = () => screen.getByRole('toolbar');
const bare = () =>
  [...bar().querySelectorAll<HTMLElement>('.ui-selection-act-label')].map(
    word => 'bare' in word.dataset
  );

describe('selection bar fit (owner, 25.11)', () => {
  it('keeps every word while they fit', () => {
    render(<Bar acts={['Create']} />);
    expect(bar().dataset.fit).toBe('full');
    expect(bare()).toEqual([false]);
  });

  it('lets the clear button’s word go first, and keeps the acts’ words', () => {
    render(<Bar acts={['Create', 'Process']} />);
    expect(bar().dataset.fit).toBe('tight');
    expect(bare()).toEqual([false, false]);
  });

  it('then lets the acts’ words go one at a time from the last, not all at once', () => {
    render(<Bar acts={['Create', 'Process', 'Trash']} />);
    expect(bar().dataset.fit).toBe('tight');
    expect(bare()).toEqual([false, false, true]);
  });

  it('measures again when what it holds changes', () => {
    const { rerender } = render(<Bar acts={['Create', 'Process', 'Trash']} />);
    rerender(<Bar acts={['Create']} />);
    expect(bar().dataset.fit).toBe('full');
    expect(bare()).toEqual([false]);
  });
});
