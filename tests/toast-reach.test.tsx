// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../apps/web/src/components/Modal';
import { ToastProvider, useToasts } from '../apps/web/src/components/toast';

afterEach(cleanup);

function DeletingDialog({ onUndo }: { onUndo: () => void }) {
  const { push } = useToasts();
  return (
    <Modal labelledBy="deleting-title" onClose={() => {}}>
      <h2 id="deleting-title">Attachments</h2>
      <button
        type="button"
        onClick={() =>
          push({
            tone: 'info',
            text: 'Detached',
            sticky: true,
            action: { label: 'Undo', run: onUndo }
          })
        }
      >
        Detach
      </button>
    </Modal>
  );
}

/**
 * T113 — the toast channel reaches every surface that raises one (024).
 *
 * A dialog that removes something offers Undo in a toast, while the dialog is
 * still up. That Undo has to be above the dialog and reachable from it.
 */
describe('a toast raised from inside a dialog', () => {
  it('lives on the body, beside the dialog rather than under the page', async () => {
    const { container } = render(
      <ToastProvider>
        <main>
          <DeletingDialog onUndo={() => {}} />
        </main>
      </ToastProvider>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Detach' }));
    const region = document.querySelector('.ui-toast-region');
    expect(region?.parentElement).toBe(document.body);
    expect(container.contains(region)).toBe(false);
  });

  it('keeps its Undo inside the dialog’s tab loop', async () => {
    const undo = vi.fn();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <DeletingDialog onUndo={undo} />
      </ToastProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Detach' }));
    screen.getByRole('button', { name: 'Detach' }).focus();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
    await user.keyboard('{Enter}');
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
