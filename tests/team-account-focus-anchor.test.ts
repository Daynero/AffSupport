// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  retainAccountFocusAnchor,
  scheduleAccountFocusReveal
} from '../apps/web/src/team/accounts/accountFocusAnchor';
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  document.body.replaceChildren();
  frames.clear();
  vi.unstubAllGlobals();
});
function paint() {
  const queued = [...frames.values()];
  frames.clear();
  for (const callback of queued) callback(0);
}
function fixture() {
  const table = document.createElement('div');
  const captions = document.createElement('div');
  captions.className = 'team-accounts-columns';
  const input = document.createElement('input');
  table.append(captions, input);
  document.body.append(table);
  Object.defineProperty(table, 'clientHeight', { value: 500 });
  table.getBoundingClientRect = () => new DOMRect(0, 100, 1000, 500);
  captions.getBoundingClientRect = () => new DOMRect(0, 100, 1000, 60);
  let contentTop = 300;
  input.getBoundingClientRect = () => new DOMRect(500, 100 + contentTop - table.scrollTop, 100, 40);
  return {
    table,
    input,
    expandAbove: (top: number) => {
      contentTop = top;
    }
  };
}
it('reveals focused controls below sticky captions after neighboring deferred height settles', () => {
  const f = fixture();
  f.table.scrollLeft = 123;
  const release = retainAccountFocusAnchor(f.table);
  f.input.focus();
  paint();
  expect(f.table.scrollTop).toBe(0);
  f.expandAbove(1500);
  scheduleAccountFocusReveal(f.table);
  paint();
  expect(f.input.getBoundingClientRect().bottom).toBe(600);
  expect(f.input.getBoundingClientRect().top).toBeGreaterThanOrEqual(160);
  expect(f.table.scrollLeft).toBe(123);
  f.expandAbove(60);
  scheduleAccountFocusReveal(f.table);
  paint();
  expect(f.input.getBoundingClientRect().top).toBe(160);
  release();
});
it.each(['wheel', 'touchmove', 'pointerdown'])(
  'does not pull back an intentional %s scroll',
  type => {
    const f = fixture();
    const release = retainAccountFocusAnchor(f.table);
    f.input.focus();
    paint();
    f.table.dispatchEvent(new Event(type, { bubbles: true }));
    f.expandAbove(2500);
    scheduleAccountFocusReveal(f.table);
    paint();
    expect(f.table.scrollTop).toBe(0);
    release();
  }
);
it('reveals a clipped fitting field horizontally inside the scrollport', () => {
  const f = fixture();
  Object.defineProperty(f.table, 'clientWidth', { value: 324 });
  f.input.getBoundingClientRect = () => new DOMRect(330 - f.table.scrollLeft, 200, 252, 40);
  const release = retainAccountFocusAnchor(f.table);
  f.input.focus();
  paint();
  expect(f.input.getBoundingClientRect().right).toBe(324);
  expect(f.input.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  expect(f.table.scrollTop).toBe(0);
  release();
});
it('reveals the whole inline field including its clear control', () => {
  const f = fixture();
  Object.defineProperty(f.table, 'clientWidth', { value: 324 });
  const wrapper = document.createElement('div');
  wrapper.className = 'team-accounts-field';
  f.input.replaceWith(wrapper);
  wrapper.append(f.input, document.createElement('button'));
  wrapper.getBoundingClientRect = () => new DOMRect(106 - f.table.scrollLeft, 200, 288, 40);
  f.input.getBoundingClientRect = () => new DOMRect(119 - f.table.scrollLeft, 200, 238, 40);
  const release = retainAccountFocusAnchor(f.table);
  f.input.focus();
  paint();
  expect(wrapper.getBoundingClientRect().right).toBe(324);
  expect(wrapper.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  release();
});
it('removes the shared guard and queued frame after the last mounted group leaves', () => {
  const f = fixture();
  const first = retainAccountFocusAnchor(f.table);
  const second = retainAccountFocusAnchor(f.table);
  first();
  f.input.focus();
  f.expandAbove(1500);
  paint();
  expect(f.table.scrollTop).toBe(1040);
  scheduleAccountFocusReveal(f.table);
  second();
  expect(frames.size).toBe(0);
  f.input.blur();
  f.input.focus();
  expect(frames.size).toBe(0);
});
