// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../apps/web/src/components/ui/Overlay';

function Harness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button onClick={() => setOpen(value => !value)}>toggle</button>
      {open && (
        <Modal title="Rename" onClose={() => setOpen(false)}>
          <input aria-label="Name" defaultValue="" />
        </Modal>
      )}
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no Web Animations; a real browser does, and only there is the
  // leaving copy made.
  Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [] });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'getAnimations');
  document.body.querySelectorAll('.is-closing').forEach(node => node.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('leaving overlays (058, FR-019)', () => {
  it('leaves an inert copy in a closed dialog’s place that plays out and removes itself', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft' } });
    fireEvent.click(screen.getByText('toggle'));

    expect(screen.queryByRole('dialog')).toBeNull();
    const ghost = document.body.querySelector<HTMLElement>('.ui-overlay.is-closing');
    expect(ghost).not.toBeNull();
    expect(ghost!.getAttribute('aria-hidden')).toBe('true');
    expect(ghost!.hasAttribute('inert')).toBe(true);
    // The copy keeps what was typed, so the content does not change as it fades.
    expect(ghost!.querySelector('input')!.value).toBe('Draft');
    // No ids survive to clash with the next dialog's, and nothing in it is a dialog.
    expect(ghost!.querySelector('[id]')).toBeNull();
    expect(ghost!.querySelector('[role]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.body.querySelector('.ui-overlay.is-closing')).toBeNull();
  });

  it('removes the copy as soon as its own animation ends', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('toggle'));
    const ghost = document.body.querySelector<HTMLElement>('.ui-overlay.is-closing')!;
    fireEvent.animationEnd(ghost);
    expect(document.body.querySelector('.ui-overlay.is-closing')).toBeNull();
  });

  it('leaves at once under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    render(<Harness />);
    fireEvent.click(screen.getByText('toggle'));
    expect(document.body.querySelector('.is-closing')).toBeNull();
  });

  it('makes no copy in an engine that cannot animate it', () => {
    Reflect.deleteProperty(document, 'getAnimations');
    render(<Harness />);
    fireEvent.click(screen.getByText('toggle'));
    expect(document.body.querySelector('.is-closing')).toBeNull();
  });

  it('does not copy a surface that holds media', () => {
    function WithVideo() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(false)}>close</button>
          {open && (
            <Modal title="Preview" onClose={() => setOpen(false)}>
              <video />
            </Modal>
          )}
        </>
      );
    }
    render(<WithVideo />);
    fireEvent.click(screen.getByText('close'));
    expect(document.body.querySelector('.is-closing')).toBeNull();
  });
});
