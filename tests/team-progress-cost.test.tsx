// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastProvider, useToasts, type ToastContextValue } from '../apps/web/src/components/toast';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('local byte-progress updates do not add cloud fetches or subscriptions', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  let api: ToastContextValue;
  function Capture() {
    api = useToasts();
    return null;
  }
  render(
    <ToastProvider>
      <Capture />
    </ToastProvider>
  );
  let id = 0;
  act(() => {
    id = api.push({
      tone: 'info',
      text: 'Uploading',
      sticky: true,
      stageLabel: 'Transferring',
      progress: 0
    });
  });
  for (let completed = 1; completed <= 100; completed += 1)
    act(() => api.update(id, { progress: completed }));
  expect(fetch).not.toHaveBeenCalled();
});
