// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Modal } from '../apps/web/src/components/Modal';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function renderModal(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  return render(
    <Modal labelledBy="modal-title" {...props}>
      <h2 id="modal-title">Title</h2>
      <button type="button">First</button>
      <button type="button">Last</button>
    </Modal>
  );
}

describe('Modal primitive', () => {
  it('renders dialog semantics and the optional close button', () => {
    const onClose = vi.fn();
    renderModal({ onClose, closeLabel: 'Close dialog' });

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('modal-title');
    // Portaled into <body>, not into the test container.
    expect(dialog.closest('body')).toBe(document.body);

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape unless disabled', () => {
    const onClose = vi.fn();
    const view = renderModal({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();

    const blocked = vi.fn();
    renderModal({ onClose: blocked, closeOnEscape: false });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(blocked).not.toHaveBeenCalled();
  });

  it('closes when the backdrop itself is pressed, not the dialog content', () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    fireEvent.pointerDown(screen.getByRole('dialog'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'First' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('respects closeOnBackdrop={false}', () => {
    const onClose = vi.fn();
    renderModal({ onClose, closeOnBackdrop: false });
    fireEvent.pointerDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog on open, honouring initialFocus', async () => {
    const view = renderModal({});
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
    );
    view.unmount();

    renderModal({ initialFocus: 'button:last-of-type' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }))
    );
  });

  it('traps Tab inside the dialog in both directions', async () => {
    renderModal({});
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Last' });
    await waitFor(() => expect(document.activeElement).toBe(first));

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('locks body scroll while open and restores focus after closing', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const view = renderModal({});
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
    );

    view.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('prefers an explicit returnFocus target over the previously focused element', async () => {
    const previous = document.createElement('button');
    const explicit = document.createElement('button');
    document.body.append(previous, explicit);
    previous.focus();

    const view = renderModal({ returnFocus: explicit });
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));
    view.unmount();
    expect(document.activeElement).toBe(explicit);
    previous.remove();
    explicit.remove();
  });

  it('only the top-most modal of a stack reacts to Escape', () => {
    const closeParent = vi.fn();
    const closeNested = vi.fn();
    render(
      <>
        <Modal labelledBy="parent-title" onClose={closeParent}>
          <h2 id="parent-title">Parent</h2>
        </Modal>
        <Modal labelledBy="nested-title" onClose={closeNested} nested>
          <h2 id="nested-title">Nested</h2>
        </Modal>
      </>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeNested).toHaveBeenCalledOnce();
    expect(closeParent).not.toHaveBeenCalled();
  });

  it('keeps the body scroll lock until the last stacked modal closes', () => {
    function Stacked() {
      const [nestedOpen, setNestedOpen] = useState(true);
      return (
        <>
          <Modal labelledBy="parent-title">
            <h2 id="parent-title">Parent</h2>
          </Modal>
          {nestedOpen && (
            <Modal labelledBy="nested-title" onClose={() => setNestedOpen(false)} nested>
              <h2 id="nested-title">Nested</h2>
            </Modal>
          )}
        </>
      );
    }
    const view = render(<Stacked />);
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('hidden');

    view.unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
