// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  charOffsetWithin,
  joinRanges,
  splitTextByRanges
} from '../apps/web/src/transcription/selection-dom.js';

describe('native and resolved transcript selection helpers', () => {
  it('maps a DOM Range endpoint to its segment character offset', () => {
    const root = document.createElement('p');
    root.innerHTML = '<span>Hello </span><span>world</span>';
    document.body.append(root);
    const secondText = root.lastElementChild?.firstChild;
    expect(secondText).not.toBeNull();
    expect(charOffsetWithin(root, secondText!, 3)).toBe(9);
    expect(charOffsetWithin(root, root, 1)).toBe(6);
  });

  it('copies discontiguous selection ranges in natural order with punctuation', () => {
    expect(
      joinRanges('Hello, brave new world!', [
        { start: 17, end: 22 },
        { start: 0, end: 5 }
      ])
    ).toBe('Hello world');
    expect(
      joinRanges('Hello, world!', [
        { start: 0, end: 5 },
        { start: 7, end: 12 }
      ])
    ).toBe('Hello, world');
  });

  it('keeps semantic selection and karaoke as independent simultaneous layers', () => {
    const pieces = splitTextByRanges('abcdef', [{ start: 1, end: 5 }], [{ start: 3, end: 6 }]);
    expect(pieces.find(piece => piece.start === 3 && piece.end === 5)).toMatchObject({
      selected: true,
      active: true
    });
    expect(pieces.find(piece => piece.start === 5 && piece.end === 6)).toMatchObject({
      selected: false,
      active: true
    });
  });
});
