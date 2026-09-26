// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceOperationsContextOverride,
  type WorkspaceOperationsValue
} from '../apps/web/src/team/explorer/WorkspaceOperationsProvider';
import { BackgroundWorkChip } from '../apps/web/src/team/workspace/BackgroundWorkChip';

describe('workspace background summary', () => {
  it('keeps all local groups discoverable beyond the three visible toasts', async () => {
    const operations: WorkspaceOperationsValue = {
      groups: Array.from({ length: 20 }, (_, index) => ({
        id: `group-${index}`,
        teamId: 'team',
        destination: { driveFolderId: null, materialId: null },
        state: 'running',
        stage: 'transferring',
        items: [{
          clientItemKey: `item-${index}`,
          relativePath: `file-${index}.txt`,
          idempotencyKey: `key-${index}`,
          state: 'pending',
          errorCode: null
        }]
      })),
      startUploadGroup: vi.fn(),
      retryUploadGroup: vi.fn(),
      cancelGroup: vi.fn()
    };
    render(
      <WorkspaceOperationsContextOverride value={operations}>
        <BackgroundWorkChip onOpen={vi.fn()} />
      </WorkspaceOperationsContextOverride>
    );
    await userEvent.click(screen.getByRole('button', { name: /20 local operations/i }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByText(/0 of 1 items confirmed/i)).toHaveLength(20);
  });
});
