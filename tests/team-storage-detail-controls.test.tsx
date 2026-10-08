// @vitest-environment jsdom
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { StorageChip } from '../apps/web/src/team/storage/StorageChip';
import { ToastProvider } from '../apps/web/src/components/toast';

const renderState = vi.hoisted(() => ({ available: true, paused: false, setPaused: vi.fn() }));
vi.mock('../apps/web/src/team/explorer/BackgroundRenderProvider', () => ({
  useOptionalBackgroundRender: () => renderState
}));

it('separates the primary storage action from settings and the local preview switch', async () => {
  const resyncDrive = vi.fn();
  render(
    <ToastProvider>
      <StorageChip
        teamId="team"
        health={{
          kind: 'connected',
          coverage: 'partial',
          lastReconciledAt: new Date().toISOString(),
          lastConfirmedAt: new Date().toISOString(),
          nextAction: 'wait'
        }}
        client={{ resyncDrive }}
        isOwner
        canManage
        settingsHref="/team?settings=1"
        open
      />
    </ToastProvider>
  );
  const dialog = within(screen.getByRole('dialog', { name: 'Storage' }));
  expect(dialog.getByRole('link', { name: 'Open storage settings' }).className).toContain(
    'ui-button--outline'
  );
  expect(dialog.getByRole('button', { name: 'Check now' }).className).toContain('ui-color-primary');
  const previews = dialog.getByRole('switch', { name: 'Previews on this computer' });
  expect((previews as HTMLInputElement).checked).toBe(true);
  await userEvent.click(previews);
  expect(renderState.setPaused).toHaveBeenCalledWith(true);
  expect(resyncDrive).not.toHaveBeenCalled();
});
