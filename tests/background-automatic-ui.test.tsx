// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogBackgroundStalledNote } from '../apps/web/src/team/catalog-updater/CatalogBackgroundStalledNote.js';
import { BackgroundRecoveryNotice } from '../apps/web/src/team/catalog-updater/BackgroundRecoveryNotice.js';
const seam = vi.hoisted(() => ({ connection: 'connected' }));
const recovery = vi.hoisted(() => ({ disable: vi.fn(async () => ({})) }));
vi.mock('../apps/web/src/api/recovery.js', () => ({
  disableBackgroundRecovery: recovery.disable
}));
vi.mock('../apps/web/src/AgentContext.js', () => ({
  useOptionalAgent: () => ({ connection: seam.connection })
}));
afterEach(() => {
  cleanup();
  seam.connection = 'connected';
});
it('tells a stalled round to restart Soty instead of promising an automatic recovery', () => {
  render(<CatalogBackgroundStalledNote teamId="team" />);
  expect(screen.getByRole('status').textContent).toContain('Restart Soty');
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
  const view = render(<BackgroundRecoveryNotice teamId="team" status={status} errorCode={null} />);
  expect(screen.queryByRole('alert')).toBeNull();
  view.rerender(
    <BackgroundRecoveryNotice
      teamId="team"
      status={{ ...status, automaticSetup: 'blocked' }}
      errorCode={null}
    />
  );
  expect(screen.getByRole('status').textContent).toContain('Background work is waiting');
  expect(screen.queryByRole('button')).toBeNull();
});

it('offers to set up again when Soty lost its own credential, not «no permission»', async () => {
  const status = {
    enabled: true,
    installationId: 'installation',
    state: 'blocked',
    reason: 'needs_agent_setup',
    automaticSetup: 'blocked' as const
  };
  render(<BackgroundRecoveryNotice teamId="team-1" status={status} errorCode={null} />);
  expect(screen.getByRole('status').textContent).toContain('lost its permission');
  fireEvent.click(screen.getByRole('button', { name: 'Set up again' }));
  await waitFor(() => expect(recovery.disable).toHaveBeenCalledWith('team-1'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Set up again' }).hasAttribute('disabled')).toBe(
      false
    )
  );
});
it('keeps a revoked permission as it was: no repair button', () => {
  render(
    <BackgroundRecoveryNotice
      teamId="team-1"
      status={{
        enabled: true,
        installationId: 'installation',
        state: 'blocked',
        reason: 'permission_revoked',
        automaticSetup: 'blocked'
      }}
      errorCode={null}
    />
  );
  expect(screen.queryByRole('button')).toBeNull();
});
