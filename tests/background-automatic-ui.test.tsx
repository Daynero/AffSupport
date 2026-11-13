// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogBackgroundStalledNote } from '../apps/web/src/team/catalog-updater/CatalogBackgroundStalledNote.js';
import { BackgroundRecoveryNotice } from '../apps/web/src/team/catalog-updater/BackgroundRecoveryNotice.js';
const seam = vi.hoisted(() => ({ connection: 'connected' }));
vi.mock('../apps/web/src/AgentContext.js', () => ({
  useOptionalAgent: () => ({ connection: seam.connection })
}));
afterEach(() => {
  cleanup();
  seam.connection = 'connected';
});
it('shows automatic recovery without a settings/enable/status button', () => {
  render(<CatalogBackgroundStalledNote teamId="team" />);
  expect(screen.getByRole('status').textContent).toContain('Waiting for automatic recovery');
  expect(screen.queryByRole('button')).toBeNull();
});
it('reports connection dependency honestly instead of claiming a successful retry', () => {
  seam.connection = 'disconnected';
  render(<CatalogBackgroundStalledNote teamId="team" />);
  expect(screen.getByRole('status').textContent).toContain('Waiting for the computer agent');
});
it('keeps ordinary setup quiet and exposes blocked ownership without an opt-in', () => {
  const status = {
    enabled: false,
    installationId: 'installation',
    state: 'pending',
    reason: null,
    automaticSetup: 'eligible' as const
  };
  const view = render(<BackgroundRecoveryNotice status={status} errorCode={null} />);
  expect(screen.queryByRole('alert')).toBeNull();
  view.rerender(
    <BackgroundRecoveryNotice status={{ ...status, automaticSetup: 'blocked' }} errorCode={null} />
  );
  expect(screen.getByRole('status').textContent).toContain('Background work is waiting');
  expect(screen.queryByRole('button')).toBeNull();
});
