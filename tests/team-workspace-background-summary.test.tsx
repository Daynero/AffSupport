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
  it('keeps a completed local result available without offering a retry', async () => {
    const value: WorkspaceOperationsValue = {
      groups: [
        {
          id: 'done',
          teamId: 'team',
          destination: { driveFolderId: null, materialId: null },
          state: 'succeeded',
          stage: 'done',
          items: [
            {
              clientItemKey: 'file',
              relativePath: 'file.txt',
              idempotencyKey: 'key',
              state: 'succeeded',
              errorCode: null
            }
          ]
        }
      ],
      startUploadGroup: vi.fn(),
      retryUploadGroup: vi.fn(),
      cancelGroup: vi.fn()
    };
    render(
      <WorkspaceOperationsContextOverride value={value}>
        <BackgroundWorkChip onOpen={vi.fn()} onRetryGroup={vi.fn()} />
      </WorkspaceOperationsContextOverride>
    );
    await userEvent.click(screen.getByRole('button', { name: /1 local operations/i }));
    expect(screen.getByText(/Operation completed/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry operation' })).toBeNull();
  });

  it('retains partial failures for review and cancels only the selected active group', async () => {
    const cancelGroup = vi.fn().mockReturnValue(true);
    const operations: WorkspaceOperationsValue = {
      groups: [
        {
          id: 'running',
          teamId: 'team',
          destination: { driveFolderId: null, materialId: null },
          state: 'running',
          stage: 'transferring',
          items: [
            {
              clientItemKey: 'pending',
              relativePath: 'active.txt',
              idempotencyKey: 'key-a',
              state: 'pending',
              errorCode: null
            }
          ]
        },
        {
          id: 'partial',
          teamId: 'team',
          destination: { driveFolderId: null, materialId: null },
          state: 'partial',
          stage: 'done',
          items: [
            {
              clientItemKey: 'saved',
              relativePath: 'saved.txt',
              idempotencyKey: 'key-b',
              state: 'succeeded',
              errorCode: null
            },
            {
              clientItemKey: 'failed',
              relativePath: 'root/failed.txt',
              idempotencyKey: 'key-c',
              state: 'failed',
              errorCode: 'PERMISSION_DENIED'
            }
          ]
        }
      ],
      startUploadGroup: vi.fn(),
      retryUploadGroup: vi.fn(),
      cancelGroup
    };
    render(
      <WorkspaceOperationsContextOverride value={operations}>
        <BackgroundWorkChip onOpen={vi.fn()} />
      </WorkspaceOperationsContextOverride>
    );
    await userEvent.click(screen.getByRole('button', { name: /2 local operations/i }));
    expect(screen.getAllByText(/root\/failed.txt/)).toHaveLength(2);
    expect(screen.getByText(/Some items completed/i)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel operation' }));
    expect(cancelGroup).toHaveBeenCalledExactlyOnceWith('running');
  });

  it('explains reselection and session-only recovery without starting network work', async () => {
    const onRetryGroup = vi.fn();
    const operations: WorkspaceOperationsValue = {
      groups: [
        {
          id: 'interrupted',
          teamId: 'team',
          destination: { driveFolderId: null, materialId: null },
          state: 'interrupted_input_required',
          stage: 'transferring',
          items: [
            {
              clientItemKey: 'item',
              relativePath: 'file.txt',
              idempotencyKey: 'key',
              state: 'input_required',
              errorCode: null
            }
          ]
        }
      ],
      sessionOnly: true,
      startUploadGroup: vi.fn(),
      retryUploadGroup: vi.fn(),
      cancelGroup: vi.fn()
    };
    render(
      <WorkspaceOperationsContextOverride value={operations}>
        <BackgroundWorkChip onOpen={vi.fn()} onRetryGroup={onRetryGroup} />
      </WorkspaceOperationsContextOverride>
    );
    expect(screen.getByText(/only until this tab closes/i)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /1 local operations/i }));
    expect(screen.getByText(/Select the same files again/i)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry operation' }));
    expect(onRetryGroup).toHaveBeenCalledWith(operations.groups[0]);
    expect(operations.retryUploadGroup).not.toHaveBeenCalled();
  });

  it('keeps all local groups discoverable beyond the three visible toasts', async () => {
    const operations: WorkspaceOperationsValue = {
      groups: Array.from({ length: 20 }, (_, index) => ({
        id: `group-${index}`,
        teamId: 'team',
        destination: { driveFolderId: null, materialId: null },
        state: 'running',
        stage: 'transferring',
        items: [
          {
            clientItemKey: `item-${index}`,
            relativePath: `file-${index}.txt`,
            idempotencyKey: `key-${index}`,
            state: 'pending',
            errorCode: null
          }
        ]
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
