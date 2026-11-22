// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PermissionState
} from '../apps/web/src/components/ui/patterns';

/**
 * The four states and the confirmation (024, T032): each pattern is a
 * composition of the inventory, and each says what it is in words.
 */
afterEach(cleanup);

describe('state patterns', () => {
  it('names an empty state and offers its way out', () => {
    render(
      <EmptyState
        title="Nothing here yet"
        description="Add the first one."
        action={<button type="button">Add</button>}
      />
    );
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });

  it('announces what is loading', () => {
    render(<LoadingState label="Loading rows" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(within(status).getByText('Loading rows')).toBeTruthy();
  });

  it('raises an error as an alert and retries when it can', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="Failed"
        message="The list did not load."
        onRetry={onRetry}
        retryLabel="Retry"
      />
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('The list did not load.')).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('offers no retry when trying again cannot work', () => {
    render(<ErrorState message="Gone." />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('explains a permission rather than showing a dead control', () => {
    render(<PermissionState message="Only the owner can change this." />);
    expect(screen.getByText('Only the owner can change this.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ConfirmDialog', () => {
  it('describes the dialog with its body', () => {
    render(
      <ConfirmDialog
        title="Delete it?"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Keep"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete it?' });
    const body = within(dialog).getByText('This cannot be undone.');
    expect(dialog.getAttribute('aria-describedby')).toBe(body.id);
  });

  it('puts the forward answer last in a benign question and offers the alternative', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const alternative = vi.fn();
    render(
      <ConfirmDialog
        tone="neutral"
        title="Leave?"
        body="Your draft is kept."
        confirmLabel="Leave"
        cancelLabel="Stay"
        alternative={{ label: 'Save first', onSelect: alternative }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Leave?' });
    const buttons = within(dialog)
      .getAllByRole('button')
      .map(button => button.textContent);
    expect(buttons.slice(-3)).toEqual(['Stay', 'Save first', 'Leave']);
    await user.click(within(dialog).getByRole('button', { name: 'Save first' }));
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    await user.click(within(dialog).getByRole('button', { name: 'Leave' }));
    expect(alternative).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('keeps a destructive alternative between the quiet confirm and the safe cancel', async () => {
    const user = userEvent.setup();
    const alternative = vi.fn();
    render(
      <ConfirmDialog
        title="Delete agent?"
        body="Its runs go with it."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        alternative={{ label: 'Archive', onSelect: alternative }}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete agent?' });
    const labels = within(dialog)
      .getAllByRole('button')
      .map(button => button.textContent);
    expect(labels.slice(-3)).toEqual(['Delete', 'Archive', 'Cancel']);
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(alternative).toHaveBeenCalledOnce();
  });

  it('asks a held press for a deletion that carries a hold hint', () => {
    render(
      <ConfirmDialog
        title="Delete for good?"
        body="Nothing can bring it back."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        holdHint="Hold to delete"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete for good?' });
    expect(within(dialog).getByText('Hold to delete')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Delete/ })).toBeTruthy();
  });
});
