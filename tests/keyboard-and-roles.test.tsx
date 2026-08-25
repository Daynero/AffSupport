// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FOCUSABLE_SELECTOR, Modal } from '../apps/web/src/components/Modal';
import { SegmentedControl } from '../apps/web/src/components/ui';
import userEvent from '@testing-library/user-event';

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
      <Modal onClose={() => {}} labelledBy="t">
        <h2 id="t">Editor</h2>
        <div contentEditable data-testid="editor" suppressContentEditableWarning />
      </Modal>
    );
    const editor = screen.getByTestId('editor');
    expect(editor.matches(FOCUSABLE_SELECTOR)).toBe(true);
  });

  it('reaches media controls', () => {
    render(
      <Modal onClose={() => {}} labelledBy="t">
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
      <Modal onClose={() => {}} labelledBy="t">
        <h2 id="t">Notes</h2>
        <div contentEditable={false} data-testid="readonly" />
      </Modal>
    );
    expect(screen.getByTestId('readonly').matches(FOCUSABLE_SELECTOR)).toBe(false);
  });
});

describe('the segmented control', () => {
  /**
   * A radio group has a keyboard convention older than the web: one Tab stop
   * for the group, arrows to move within it. This one had neither — every
   * option was its own Tab stop, so a settings form with three controls cost
   * nine presses to cross, and the arrow keys did nothing at all.
   */

  function render3(value: string, onChange: (next: string) => void) {
    return render(
      <SegmentedControl
        label="Mode"
        value={value}
        onChange={onChange}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' }
        ]}
      />
    );
  }

  it('is a single tab stop', () => {
    render3('b', () => {});
    const options = screen.getAllByRole('radio');
    // Exactly one reachable by Tab: the chosen one, which is where a keyboard
    // user expects to land.
    expect(options.filter(option => option.tabIndex === 0)).toHaveLength(1);
    expect(options.find(option => option.tabIndex === 0)?.textContent).toBe('B');
  });

  it('moves to the next option on an arrow key', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    render3('a', next => changes.push(next));

    screen.getAllByRole('radio')[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(changes).toEqual(['b']);
  });

  it('wraps from the last option to the first', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    render3('c', next => changes.push(next));

    screen.getAllByRole('radio')[2].focus();
    await user.keyboard('{ArrowRight}');
    // Wrapping is the convention. Stopping at the end reads as a broken key.
    expect(changes).toEqual(['a']);
  });

  it('reports which option is chosen', () => {
    render3('b', () => {});
    const checked = screen
      .getAllByRole('radio')
      .filter(o => o.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
  });
});
