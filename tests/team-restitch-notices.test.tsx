// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider, useToasts } from '../apps/web/src/components/toast';
import { RestitchDeliveryNotices } from '../apps/web/src/team/restitch/RestitchDeliveryNotices';
import type { RestitchDeliveryState } from '../apps/web/src/team/restitch/useRestitchDelivery';

vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => true })
}));
beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Host({ states }: { states: Record<string, RestitchDeliveryState> }) {
  const renders = React.useRef(0);
  if (++renders.current > 30) throw new Error('Delivery notice render loop');
  useToasts();
  // Like ExplorerShell: this callback gets a new identity on each provider update.
  return <RestitchDeliveryNotices states={states} onConfigure={() => {}} />;
}

it('reports a failed download once without a toast/provider render loop', () => {
  const states: Record<string, RestitchDeliveryState> = {
    video: { kind: 'failed', message: 'Choose a photo.' }
  };
  const view = render(
    <ToastProvider>
      <Host states={states} />
    </ToastProvider>
  );
  expect(screen.getAllByText('Choose a photo.')).toHaveLength(1);
  view.rerender(
    <ToastProvider>
      <Host states={{ ...states }} />
    </ToastProvider>
  );
  expect(screen.getAllByText('Choose a photo.')).toHaveLength(1);
  view.rerender(
    <ToastProvider>
      <Host states={{ video: { kind: 'failed', message: 'Source changed.' } }} />
    </ToastProvider>
  );
  expect(screen.getByText('Source changed.')).toBeTruthy();
  expect(screen.queryByText('Choose a photo.')).toBeNull();
});
