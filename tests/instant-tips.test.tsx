// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { InstantTips } from '../apps/web/src/components/InstantTips';
afterEach(cleanup);
it('clears stationary background hints when a modal opens and blocks subsequent background hover', async () => {
  const view = render(
    <>
      <InstantTips />
      <button data-tip="Background hint">Background</button>
    </>
  );
  fireEvent.mouseOver(screen.getByRole('button'));
  expect(screen.getByText('Background hint')).toBeTruthy();
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
  expect(screen.getByText('Dialog hint')).toBeTruthy();
  fireEvent.mouseOver(screen.getByRole('dialog'));
  expect(screen.queryByText('Dialog hint')).toBeNull();
});

it('only shows an overflow hint when the name is clipped, rechecking after resize', () => {
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
  expect(screen.getByText('Full launch name')).toBeTruthy();
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
  expect(screen.getByText('Row stage')).toBeTruthy();
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
  expect(screen.getByText('Checking Drive')).toBeTruthy();
  rerender(
    <>
      <InstantTips />
      <div>Catalog</div>
    </>
  );
  await waitFor(() => expect(screen.queryByText('Checking Drive')).toBeNull());
});
