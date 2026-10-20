// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDeferredAccountRows } from '../apps/web/src/team/accounts/useDeferredAccountRows';

const observers: {
  callback: IntersectionObserverCallback;
  targets: Set<Element>;
  disconnected: boolean;
}[] = [];
class Observer {
  item: (typeof observers)[number];
  constructor(callback: IntersectionObserverCallback) {
    this.item = { callback, targets: new Set(), disconnected: false };
    observers.push(this.item);
  }
  observe(node: Element) {
    this.item.targets.add(node);
  }
  unobserve(node: Element) {
    this.item.targets.delete(node);
  }
  disconnect() {
    this.item.disconnected = true;
  }
}
function visibility(near: boolean) {
  for (const observer of observers.filter(item => !item.disconnected))
    observer.callback(
      [...observer.targets].map(
        target => ({ target, isIntersecting: near }) as IntersectionObserverEntry
      ),
      {} as IntersectionObserver
    );
}
function Rows({ force = false }: { force?: boolean }) {
  const deferred = useDeferredAccountRows({
    enabled: true,
    initialVisible: false,
    force,
    estimatedUnits: 10
  });
  return (
    <div className="team-accounts-table">
      <section>
        <button>Social heading</button>
        <div ref={deferred.ref} style={deferred.renderRows ? undefined : deferred.placeholderStyle}>
          {deferred.renderRows ? (
            <input aria-label="Dated field" defaultValue="" />
          ) : (
            <span data-testid="placeholder" />
          )}
        </div>
      </section>
    </div>
  );
}
afterEach(() => {
  cleanup();
  observers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('mounts controls near the scroll viewport and releases them offscreen without removing the heading', () => {
  vi.stubGlobal('IntersectionObserver', Observer);
  render(<Rows />);
  expect(screen.queryByLabelText('Dated field')).toBeNull();
  expect(screen.getByRole('button', { name: 'Social heading' })).toBeTruthy();
  act(() => visibility(true));
  expect(screen.getByLabelText('Dated field')).toBeTruthy();
  act(() => visibility(false));
  expect(screen.queryByLabelText('Dated field')).toBeNull();
  expect(
    screen
      .getByTestId('placeholder')
      .parentElement?.style.getPropertyValue('--account-deferred-units')
  ).toBe('10');
});
it('preserves measured variable row height when the controls leave the viewport', () => {
  vi.stubGlobal('IntersectionObserver', Observer);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    height: 732
  } as DOMRect);
  render(<Rows />);
  act(() => visibility(true));
  act(() => visibility(false));
  expect(
    screen
      .getByTestId('placeholder')
      .parentElement?.style.getPropertyValue('--account-deferred-height')
  ).toBe('732px');
});
it('keeps a focused field and an active editor mounted outside the observation range', async () => {
  vi.stubGlobal('IntersectionObserver', Observer);
  const view = render(<Rows />);
  act(() => visibility(true));
  act(() => screen.getByLabelText('Dated field').focus());
  fireEvent.change(screen.getByLabelText('Dated field'), { target: { value: '42' } });
  act(() => visibility(false));
  expect((screen.getByLabelText('Dated field') as HTMLInputElement).value).toBe('42');
  view.rerender(<Rows force />);
  await act(async () => screen.getByLabelText('Dated field').blur());
  expect(screen.getByLabelText('Dated field')).toBeTruthy();
  view.rerender(<Rows />);
  expect(screen.queryByLabelText('Dated field')).toBeNull();
});
it('keeps the full fallback accessible when the browser lacks IntersectionObserver and disconnects on unmount', () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const fallback = render(<Rows />);
  expect(screen.getByLabelText('Dated field')).toBeTruthy();
  fallback.unmount();
  vi.stubGlobal('IntersectionObserver', Observer);
  const observed = render(<Rows />);
  observed.unmount();
  expect(observers.every(item => item.disconnected)).toBe(true);
});
