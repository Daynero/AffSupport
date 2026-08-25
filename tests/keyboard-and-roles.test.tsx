// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FOCUSABLE_SELECTOR, Modal } from '../apps/web/src/components/Modal';

/**
 * Three things a keyboard or a screen reader could not do.
 *
 * All of them look fine on a screen, which is why they survived: a control that
 * announces itself wrongly is invisible to everyone testing with a mouse.
 */

afterEach(cleanup);

describe('the dialog focus trap', () => {
  it('reaches an editable region', () => {
    // The transcript editor is a contenteditable region. It is focusable
    // without a tabindex, so a selector built from tabindex and form controls
    // never saw it — and a user who tabbed into a dialog containing one could
    // not reach the thing the dialog exists to edit.
    render(
      <Modal open onClose={() => {}} labelledBy="t">
        <h2 id="t">Editor</h2>
        <div contentEditable data-testid="editor" suppressContentEditableWarning />
      </Modal>
    );
    const editor = screen.getByTestId('editor');
    expect(editor.matches(FOCUSABLE_SELECTOR)).toBe(true);
  });

  it('reaches media controls', () => {
    render(
      <Modal open onClose={() => {}} labelledBy="t">
        <h2 id="t">Preview</h2>
        <video controls data-testid="player" />
      </Modal>
    );
    expect(screen.getByTestId('player').matches(FOCUSABLE_SELECTOR)).toBe(true);
  });

  it('does not reach a region explicitly marked uneditable', () => {
    // `contenteditable="false"` is the author saying "read only". Trapping
    // focus in it would be the fix overshooting into a new bug.
    render(
      <Modal open onClose={() => {}} labelledBy="t">
        <h2 id="t">Notes</h2>
        <div contentEditable={false} data-testid="readonly" />
      </Modal>
    );
    expect(screen.getByTestId('readonly').matches(FOCUSABLE_SELECTOR)).toBe(false);
  });
});
