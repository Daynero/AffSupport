// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWorkChip } from '../apps/web/src/team/workspace/BackgroundWorkChip';
import type { WorkspaceOperationGroup } from '../apps/web/src/team/explorer/WorkspaceOperationsProvider';

const state = vi.hoisted(() => ({ groups: [] as WorkspaceOperationGroup[] }));
vi.mock('../apps/web/src/team/explorer/WorkspaceOperationsProvider', () => ({
  useOptionalWorkspaceOperations: () => ({
    groups: state.groups,
    sessionOnly: false,
    cancelGroup: vi.fn()
  })
}));
vi.mock('../apps/web/src/team/library/LibraryProcessingProvider', () => ({
  useOptionalLibraryProcessing: () => null
}));

afterEach(() => {
  cleanup();
  state.groups = [];
});

function group(stateName: WorkspaceOperationGroup['state']): WorkspaceOperationGroup {
  return {
    id: 'group-1',
    teamId: 'team-1',
    destination: { driveFolderId: null, materialId: null },
    state: stateName,
    stage: stateName === 'running' ? 'transferring' : 'done',
    items: [
      {
        clientItemKey: 'item-1',
        relativePath: 'clip.mp4',
        idempotencyKey: 'key-1',
        state: stateName === 'succeeded' ? 'succeeded' : 'failed',
        errorCode: null
      }
    ]
  };
}

describe('background work history chip', () => {
  it.each(['succeeded', 'failed'] as const)(
    'keeps a %s result readable without a spinner',
    async result => {
      state.groups = [group(result)];
      render(<BackgroundWorkChip onOpen={vi.fn()} />);
      const chip = screen.getByRole('button', { name: /local operations/i });
      expect(chip.querySelector('.ui-chip-spinner')).toBeNull();
      expect(chip.classList.contains('ui-chip-busy')).toBe(false);
      await userEvent.setup().click(chip);
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByText('clip.mp4')).toBeTruthy();
    }
  );

  it('animates while work is running and stops after it settles', () => {
    state.groups = [group('running')];
    const view = render(<BackgroundWorkChip onOpen={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /local operations/i }).querySelector('.ui-chip-spinner')
    ).toBeTruthy();
    state.groups = [group('succeeded')];
    view.rerender(<BackgroundWorkChip onOpen={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /local operations/i }).querySelector('.ui-chip-spinner')
    ).toBeNull();
  });
});
