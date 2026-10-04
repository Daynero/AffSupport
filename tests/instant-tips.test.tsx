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
