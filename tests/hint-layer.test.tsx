// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HintLayer } from '../apps/web/src/components/ui/HintLayer';
import { HINT_DELAY_MS, HINT_WARM_MS } from '../apps/web/src/components/ui/Feedback';
afterEach(cleanup);
it('clears stationary background hints when a modal opens and blocks subsequent background hover', async () => {
  const view = render(
    <>
      <HintLayer />
      <button title="Background hint">Background</button>
    </>
  );
  fireEvent.mouseOver(screen.getByRole('button'));
  expect(await screen.findByText('Background hint')).toBeTruthy();
  view.rerender(
    <>
      <HintLayer />
      <button title="Background hint">Background</button>
      <div role="dialog" aria-modal="true">
        <button title="Dialog hint">Inside</button>
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

it('names a cut-off name in full only while it is cut off, rechecking after resize', async () => {
  // AgentRow's run note: the hint is the note itself, so it is drawn only when
  // the row cuts the note short (it was `data-tip-overflow` before 070).
  render(
    <>
      <HintLayer />
      <span title="Full launch name">Full launch name</span>
    </>
  );
  const name = screen.getByText('Full launch name');
  let available = 200;
  Object.defineProperty(name, 'clientWidth', { get: () => available });
  Object.defineProperty(name, 'scrollWidth', { get: () => 120 });
  fireEvent.mouseOver(name);
  expect(document.querySelector('.ui-hint')).toBeNull();
  available = 100;
  fireEvent.mouseOver(name);
  await waitFor(() =>
    expect(document.querySelector('.ui-hint')?.textContent).toBe('Full launch name')
  );
  available = 120;
  fireEvent.mouseOver(name);
  expect(document.querySelector('.ui-hint')).toBeNull();
});

it('dismisses a row hint when a nonmodal panel opens and does not inherit it through that panel', async () => {
  const { rerender } = render(
    <>
      <HintLayer />
      <div title="Row stage">
        <button>Open schedule</button>
      </div>
    </>
  );
  fireEvent.mouseOver(screen.getByText('Open schedule'));
  expect(await screen.findByText('Row stage')).toBeTruthy();
  rerender(
    <>
      <HintLayer />
      <div title="Row stage">
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
      <HintLayer />
      <div title="Checking Drive">Catalog</div>
    </>
  );
  fireEvent.mouseOver(screen.getByText('Catalog'));
  expect(await screen.findByText('Checking Drive')).toBeTruthy();
  rerender(
    <>
      <HintLayer />
      <div>Catalog</div>
    </>
  );
  await waitFor(() => expect(screen.queryByText('Checking Drive')).toBeNull());
});

/** The wait is the thing under test, so the clock is driven rather than slept through. */
function withClock(run: (advance: (ms: number) => void) => void) {
  vi.useFakeTimers();
  try {
    // The group's warm-up is the product's, not the test's: a hint from the test
    // before must have cooled.
    vi.advanceTimersByTime(HINT_WARM_MS + 1);
    run(ms => act(() => void vi.advanceTimersByTime(ms)));
  } finally {
    vi.useRealTimers();
  }
}

it('waits on a still pointer, then answers the neighbouring control at once', () => {
  withClock(advance => {
    render(
      <>
        <HintLayer />
        <button title="Compress" aria-label="Compress" />
        <button title="Delete" aria-label="Delete" />
      </>
    );
    const [first, second] = screen.getAllByRole('button');
    fireEvent.mouseOver(first!);
    // Crossing a control raises nothing.
    expect(screen.queryByText('Compress')).toBeNull();
    advance(HINT_DELAY_MS / 2);
    expect(screen.queryByText('Compress')).toBeNull();
    advance(HINT_DELAY_MS / 2 + 1);
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
        <HintLayer />
        <button title="Compress" aria-label="Compress" />
      </>
    );
    const button = screen.getByRole('button');
    fireEvent.mouseOver(button);
    fireEvent.mouseOut(button);
    advance(HINT_DELAY_MS + 80);
    expect(screen.queryByText('Compress')).toBeNull();
  });
});

it('does not repeat what the control already says in full', () => {
  withClock(advance => {
    render(
      <>
        <HintLayer />
        <button title="Add files">Add files</button>
        <button title="Uploads the selection to the open folder">Add more</button>
      </>
    );
    fireEvent.mouseOver(screen.getByText('Add files'));
    advance(HINT_DELAY_MS + 80);
    expect(document.querySelector('.ui-hint')).toBeNull();
    fireEvent.mouseOver(screen.getByText('Add more'));
    advance(HINT_DELAY_MS + 1);
    expect(screen.getByText('Uploads the selection to the open folder')).toBeTruthy();
  });
});

it('still names in full a label that is cut off', async () => {
  render(
    <>
      <HintLayer />
      <span title="A very long file name.mp4">A very long file name.mp4</span>
    </>
  );
  const name = screen.getByText('A very long file name.mp4');
  Object.defineProperty(name, 'clientWidth', { get: () => 60 });
  Object.defineProperty(name, 'scrollWidth', { get: () => 240 });
  fireEvent.mouseOver(name);
  await waitFor(() => expect(document.querySelector('.ui-hint')).not.toBeNull());
});
