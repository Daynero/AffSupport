import { describe, expect, it } from 'vitest';
import {
  applyPress,
  autoScrollStep,
  boxFromPoints,
  clamp,
  exceedsThreshold,
  hasToggleModifier,
  intersects,
  marqueeMode,
  mergeSelection,
  pressKind,
  rangeBetween,
  sameSet
} from '../apps/web/src/team/explorer/selectionGestures';

const none = { shiftKey: false, metaKey: false, ctrlKey: false };
const order = ['a', 'b', 'c', 'd', 'e'];

describe('rubber band geometry', () => {
  it('normalises a rectangle drawn in any direction', () => {
    expect(boxFromPoints({ x: 50, y: 40 }, { x: 10, y: 90 })).toEqual({
      left: 10,
      top: 40,
      right: 50,
      bottom: 90
    });
  });

  it('takes what it overlaps, not what it only touches', () => {
    const tile = { left: 100, top: 100, right: 200, bottom: 200 };
    expect(intersects({ left: 150, top: 150, right: 300, bottom: 300 }, tile)).toBe(true);
    expect(intersects({ left: 0, top: 0, right: 100, bottom: 300 }, tile)).toBe(false);
    expect(intersects({ left: 0, top: 0, right: 99, bottom: 99 }, tile)).toBe(false);
    // A flat rectangle — a horizontal drag — still takes what it crosses.
    expect(intersects({ left: 0, top: 150, right: 120, bottom: 150 }, tile)).toBe(true);
    // A rectangle wholly inside a tile takes it.
    expect(intersects({ left: 120, top: 120, right: 130, bottom: 130 }, tile)).toBe(true);
  });

  it('a press that barely moves is a click', () => {
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: -3, y: -3 })).toBe(true);
  });

  it('clamps, and settles on the upper end when the range is inverted', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(5, 20, 10)).toBe(10);
  });
});

describe('modifiers', () => {
  it('reads ⌘ on a Mac and Ctrl elsewhere as the toggle', () => {
    expect(hasToggleModifier({ ...none, metaKey: true }, true)).toBe(true);
    // Ctrl+press on a Mac is the context menu, not a toggle.
    expect(hasToggleModifier({ ...none, ctrlKey: true }, true)).toBe(false);
    expect(hasToggleModifier({ ...none, ctrlKey: true }, false)).toBe(true);
  });

  it('chooses the rectangle mode, toggle winning over add', () => {
    expect(marqueeMode(none, true)).toBe('replace');
    expect(marqueeMode({ ...none, shiftKey: true }, true)).toBe('add');
    expect(marqueeMode({ ...none, metaKey: true }, true)).toBe('toggle');
    expect(marqueeMode({ shiftKey: true, metaKey: true, ctrlKey: false }, true)).toBe('toggle');
    expect(marqueeMode({ ...none, ctrlKey: true }, false)).toBe('toggle');
  });

  it('chooses the press kind the same way', () => {
    expect(pressKind(none, false)).toBe('plain');
    expect(pressKind({ ...none, shiftKey: true }, false)).toBe('range');
    expect(pressKind({ ...none, ctrlKey: true }, false)).toBe('toggle');
  });
});

describe('merging what the rectangle covers', () => {
  const start = new Set(['a', 'b']);

  it('replaces the set on a plain drag', () => {
    expect([...mergeSelection(start, ['c', 'd'], 'replace')].sort()).toEqual(['c', 'd']);
    expect(mergeSelection(start, [], 'replace').size).toBe(0);
  });

  it('adds on Shift', () => {
    expect([...mergeSelection(start, ['b', 'c'], 'add')].sort()).toEqual(['a', 'b', 'c']);
  });

  it('flips relative to the starting set on ⌘/Ctrl, and gives back what it no longer covers', () => {
    expect([...mergeSelection(start, ['b', 'c'], 'toggle')].sort()).toEqual(['a', 'c']);
    // The rectangle shrank off b and c: the starting set comes back.
    expect([...mergeSelection(start, [], 'toggle')].sort()).toEqual(['a', 'b']);
  });

  it('leaves the starting set untouched', () => {
    mergeSelection(start, ['c'], 'add');
    expect([...start]).toEqual(['a', 'b']);
  });

  it('compares sets regardless of order', () => {
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameSet(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false);
  });
});

describe('a run from the anchor', () => {
  it('includes both ends in either direction', () => {
    expect(rangeBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'c', 'c')).toEqual(['c']);
  });

  it('is empty when either end is not in view', () => {
    expect(rangeBetween(order, 'x', 'b')).toEqual([]);
    expect(rangeBetween(order, 'b', 'x')).toEqual([]);
  });
});

describe('a press on a row', () => {
  const base = { order, focusedId: null, anchor: null };

  it('plain: focuses and leaves the checked set alone — it is built across folders', () => {
    const result = applyPress({
      ...base,
      kind: 'plain',
      clickedId: 'c',
      checked: new Set(['a', 'elsewhere'])
    });
    expect(result.focusId).toBe('c');
    expect([...result.checked].sort()).toEqual(['a', 'elsewhere']);
    expect(result.anchor).toEqual({ id: 'c', base: ['a', 'elsewhere'] });
  });

  it('plain: a press inside a group keeps the group, so it can be dragged', () => {
    const result = applyPress({
      ...base,
      kind: 'plain',
      clickedId: 'b',
      checked: new Set(['a', 'b'])
    });
    expect([...result.checked].sort()).toEqual(['a', 'b']);
    expect(result.focusId).toBe('b');
  });

  it('range after a plain press: the run joins what was already checked', () => {
    const plain = applyPress({ ...base, kind: 'plain', clickedId: 'b', checked: new Set(['e']) });
    const run = applyPress({
      ...base,
      kind: 'range',
      clickedId: 'd',
      checked: plain.checked,
      anchor: plain.anchor
    });
    expect([...run.checked].sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('toggle: adds and removes one', () => {
    const added = applyPress({ ...base, kind: 'toggle', clickedId: 'c', checked: new Set(['a']) });
    expect([...added.checked].sort()).toEqual(['a', 'c']);
    const removed = applyPress({
      ...base,
      kind: 'toggle',
      clickedId: 'a',
      checked: new Set(['a', 'c'])
    });
    expect([...removed.checked]).toEqual(['c']);
  });

  it('toggle: with nothing checked, the focused row joins', () => {
    const result = applyPress({
      ...base,
      kind: 'toggle',
      clickedId: 'd',
      focusedId: 'b',
      checked: new Set()
    });
    expect([...result.checked].sort()).toEqual(['b', 'd']);
    expect(result.focusId).toBe('d');
  });

  it('toggle: a focused row from another folder does not join', () => {
    const result = applyPress({
      ...base,
      kind: 'toggle',
      clickedId: 'd',
      focusedId: 'elsewhere',
      checked: new Set()
    });
    expect([...result.checked]).toEqual(['d']);
  });

  it('toggle: ⌘-pressing the focused row on its own checks it', () => {
    const result = applyPress({
      ...base,
      kind: 'toggle',
      clickedId: 'b',
      focusedId: 'b',
      checked: new Set()
    });
    expect([...result.checked]).toEqual(['b']);
  });

  it('range: takes the run from the anchor, and re-draws it from the same anchor', () => {
    const first = applyPress({
      ...base,
      kind: 'range',
      clickedId: 'd',
      checked: new Set(),
      anchor: { id: 'b', base: [] }
    });
    expect([...first.checked].sort()).toEqual(['b', 'c', 'd']);
    const second = applyPress({
      ...base,
      kind: 'range',
      clickedId: 'a',
      checked: first.checked,
      anchor: first.anchor
    });
    expect([...second.checked].sort()).toEqual(['a', 'b']);
  });

  it('range: keeps what was checked before the run began', () => {
    const toggled = applyPress({
      ...base,
      kind: 'toggle',
      clickedId: 'a',
      checked: new Set(['elsewhere'])
    });
    const run = applyPress({
      ...base,
      kind: 'range',
      clickedId: 'c',
      checked: toggled.checked,
      anchor: toggled.anchor
    });
    expect([...run.checked].sort()).toEqual(['a', 'b', 'c', 'elsewhere']);
  });

  it('range: without an anchor, measures from the focused row', () => {
    const result = applyPress({
      ...base,
      kind: 'range',
      clickedId: 'e',
      focusedId: 'c',
      checked: new Set()
    });
    expect([...result.checked].sort()).toEqual(['c', 'd', 'e']);
    expect(result.anchor.id).toBe('c');
  });

  it('range: with nothing to measure from, adds the row on its own', () => {
    const result = applyPress({
      ...base,
      kind: 'range',
      clickedId: 'c',
      checked: new Set(['a']),
      anchor: { id: 'gone', base: [] }
    });
    expect([...result.checked].sort()).toEqual(['a', 'c']);
    expect(result.anchor.id).toBe('c');
  });
});

describe('scrolling at the edges while drawing', () => {
  it('stays still in the middle and speeds up towards either edge', () => {
    expect(autoScrollStep(400, 100, 800)).toBe(0);
    expect(autoScrollStep(140, 100, 800)).toBeLessThan(0);
    expect(autoScrollStep(110, 100, 800)).toBeLessThan(autoScrollStep(140, 100, 800));
    expect(autoScrollStep(790, 100, 800)).toBeGreaterThan(0);
    expect(autoScrollStep(2000, 100, 800)).toBe(22);
    expect(autoScrollStep(-500, 100, 800)).toBe(-22);
  });

  it('does not scroll a window too short to have a middle', () => {
    expect(autoScrollStep(50, 0, 80)).toBe(0);
  });
});
