// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InstantTips, TIP_DELAY_MS } from '../apps/web/src/components/InstantTips';
afterEach(cleanup);
it('clears stationary background hints when a modal opens and blocks subsequent background hover', async () => {
  const view = render(
    <>
      <InstantTips />
      <button data-tip="Background hint">Background</button>
    </>
  );
  fireEvent.mouseOver(screen.getByRole('button'));
  expect(await screen.findByText('Background hint')).toBeTruthy();
  view.rerender(
    <>
      <InstantTips />
      <button data-tip="Background hint">Background</button>
      <div role="dialog" aria-modal="true">
        <button data-tip="Dialog hint">Inside</button>
      </div>
    </>
  );
  await waitFor(() => expect(screen.queryByText('Background hint')).toBeNull());
  fireEvent.mouseOver(screen.getByText('Background'));
  expect(screen.queryByText('Background hint')).toBeNull();
  fireEvent.mouseOver(screen.getByText('Inside'));
  expect(await screen.findByText('Dialog hint')).toBeTruthy();
  fireEvent.mouseOver(screen.getByRole('dialog'));
  expect(screen.queryByText('Dialog hint')).toBeNull();
});

it('only shows an overflow hint when the name is clipped, rechecking after resize', async () => {
  render(
    <>
      <InstantTips />
      <span data-tip="Full launch name" data-tip-overflow>
        Launch
      </span>
    </>
  );
  const name = screen.getByText('Launch');
  let available = 200;
  Object.defineProperty(name, 'clientWidth', { get: () => available });
  Object.defineProperty(name, 'scrollWidth', { get: () => 120 });
  fireEvent.mouseOver(name);
  expect(screen.queryByText('Full launch name')).toBeNull();
  available = 100;
  fireEvent.mouseOver(name);
  expect(await screen.findByText('Full launch name')).toBeTruthy();
  available = 120;
  fireEvent.mouseOver(name);
  expect(screen.queryByText('Full launch name')).toBeNull();
});

it('dismisses a row hint when a nonmodal panel opens and does not inherit it through that panel', async () => {
  const { rerender } = render(
    <>
      <InstantTips />
      <div data-tip="Row stage">
        <button>Open schedule</button>
      </div>
    </>
  );
  fireEvent.mouseOver(screen.getByText('Open schedule'));
  expect(await screen.findByText('Row stage')).toBeTruthy();
  rerender(
    <>
      <InstantTips />
      <div data-tip="Row stage">
        <button>Open schedule</button>
      </div>
      <div role="dialog" aria-label="Schedule">
        <button>Save</button>
      </div>
    </>
  );
  await waitFor(() => expect(screen.queryByText('Row stage')).toBeNull());
  fireEvent.mouseOver(screen.getByText('Open schedule'));
  expect(screen.queryByText('Row stage')).toBeNull();
});

it('clears the stationary progress hint when its operation finishes', async () => {
  const { rerender } = render(
    <>
      <InstantTips />
      <div data-tip="Checking Drive">Catalog</div>
    </>
  );
  fireEvent.mouseOver(screen.getByText('Catalog'));
  expect(await screen.findByText('Checking Drive')).toBeTruthy();
  rerender(
    <>
      <InstantTips />
      <div>Catalog</div>
    </>
  );
  await waitFor(() => expect(screen.queryByText('Checking Drive')).toBeNull());
});

/** The wait is the thing under test, so the clock is driven rather than slept through. */
function withClock(run: (advance: (ms: number) => void) => void) {
  vi.useFakeTimers();
  try {
    run(ms => act(() => void vi.advanceTimersByTime(ms)));
  } finally {
    vi.useRealTimers();
  }
}

it('waits on a still pointer, then answers the neighbouring control at once', () => {
  withClock(advance => {
    render(
      <>
        <InstantTips />
        <button data-tip="Compress" aria-label="Compress" />
        <button data-tip="Delete" aria-label="Delete" />
      </>
    );
    const [first, second] = screen.getAllByRole('button');
    fireEvent.mouseOver(first!);
    // Crossing a control raises nothing.
    expect(screen.queryByText('Compress')).toBeNull();
    advance(TIP_DELAY_MS / 2);
    expect(screen.queryByText('Compress')).toBeNull();
    advance(TIP_DELAY_MS / 2 + 1);
    expect(screen.getByText('Compress')).toBeTruthy();
    fireEvent.mouseOut(first!);
    fireEvent.mouseOver(second!);
    expect(screen.getByText('Delete')).toBeTruthy();
  });
});

it('drops the wait when the pointer leaves before the hint shows', () => {
  withClock(advance => {
    render(
      <>
        <InstantTips />
        <button data-tip="Compress" aria-label="Compress" />
      </>
    );
    const button = screen.getByRole('button');
    fireEvent.mouseOver(button);
    fireEvent.mouseOut(button);
    advance(TIP_DELAY_MS + 80);
    expect(screen.queryByText('Compress')).toBeNull();
  });
});

it('does not repeat what the control already says in full', () => {
  withClock(advance => {
    render(
      <>
        <InstantTips />
        <button title="Add files">Add files</button>
        <button title="Uploads the selection to the open folder">Add more</button>
      </>
    );
    fireEvent.mouseOver(screen.getByText('Add files'));
    advance(TIP_DELAY_MS + 80);
    expect(document.querySelector('.instant-tip')).toBeNull();
    fireEvent.mouseOver(screen.getByText('Add more'));
    advance(TIP_DELAY_MS + 1);
    expect(screen.getByText('Uploads the selection to the open folder')).toBeTruthy();
  });
});

it('still names in full a label that is cut off', async () => {
  render(
    <>
      <InstantTips />
      <span title="A very long file name.mp4">A very long file name.mp4</span>
    </>
  );
  const name = screen.getByText('A very long file name.mp4');
  Object.defineProperty(name, 'clientWidth', { get: () => 60 });
  Object.defineProperty(name, 'scrollWidth', { get: () => 240 });
  fireEvent.mouseOver(name);
  await waitFor(() => expect(document.querySelector('.instant-tip')).not.toBeNull());
});
