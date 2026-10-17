// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider, useToasts } from '../apps/web/src/components/toast';
import { RestitchDeliveryNotices } from '../apps/web/src/team/restitch/RestitchDeliveryNotices';
import type { RestitchDeliveryState } from '../apps/web/src/team/restitch/useRestitchDelivery';

const seams = vi.hoisted(() => ({ canManage: true, configure: vi.fn() }));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => seams.canManage })
}));
beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  seams.canManage = true;
  seams.configure.mockReset();
});

function Host({ states }: { states: Record<string, RestitchDeliveryState> }) {
  const renders = React.useRef(0);
  if (++renders.current > 30) throw new Error('Delivery notice render loop');
  useToasts();
  // Like ExplorerShell: this callback gets a new identity on each provider update.
  return <RestitchDeliveryNotices states={states} onConfigure={seams.configure} />;
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

it('does not toast running work and replaces it with one delivered notice', () => {
  const view = render(
    <ToastProvider>
      <Host states={{ video: { kind: 'running', phase: 'saving', fileName: 'clip.mp4' } }} />
    </ToastProvider>
  );
  expect(screen.queryByText('Saved as clip.mp4')).toBeNull();
  view.rerender(
    <ToastProvider>
      <Host states={{ video: { kind: 'delivered', fileName: 'clip.mp4' } }} />
    </ToastProvider>
  );
  expect(screen.getAllByText('Saved as clip.mp4')).toHaveLength(1);
  view.rerender(
    <ToastProvider>
      <Host states={{ video: { kind: 'delivered', fileName: 'clip.mp4' } }} />
    </ToastProvider>
  );
  expect(screen.getAllByText('Saved as clip.mp4')).toHaveLength(1);
});

it('offers setup to a manager and names the manager for a viewer', () => {
  const configured = render(
    <ToastProvider>
      <Host states={{ video: { kind: 'unconfigured' } }} />
    </ToastProvider>
  );
  expect(screen.getByText('Re-stitching is not set up for this space')).toBeTruthy();
  screen.getByRole('button', { name: 'Set it up now' }).click();
  expect(seams.configure).toHaveBeenCalledOnce();
  configured.unmount();

  seams.canManage = false;
  render(
    <ToastProvider>
      <Host states={{ video: { kind: 'unconfigured' } }} />
    </ToastProvider>
  );
  expect(screen.getByText(/A space manager can set it up/u)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Set it up now' })).toBeNull();
});
