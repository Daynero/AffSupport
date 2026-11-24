// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FOCUSABLE_SELECTOR, Modal } from '../apps/web/src/components/Modal';
import { SegmentedControl } from '../apps/web/src/components/ui/index';
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
   * for the group, arrows to move within it. The pre-021 control had neither
   * at first — every option was its own Tab stop, so a settings form with three
   * controls cost nine presses to cross. The inventory's control (React Aria's
   * toggle-button group, 070 T065 moved this test onto it) keeps the contract
   * that matters: one Tab crosses the group, arrows move between options, the
   * chosen one is what a reader hears as checked. Two details are React Aria's
   * rather than the old control's: arrows stop at the ends instead of wrapping,
   * and an arrow moves focus without choosing — Space chooses.
   */

  function render3(value: string, onChange: (next: string) => void) {
    return render(
      <>
        <button type="button">before</button>
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
        <button type="button">after</button>
      </>
    );
  }

  it('is a single tab stop', () => {
    render3('b', () => {});
    const [a, , c] = screen.getAllByRole('radio');
    // React Aria's toolbar answers Tab by moving focus to the group's last
    // option and letting the browser carry on from there — so the next stop is
    // past the group, whichever option Tab was pressed on. jsdom does not run
    // the browser's half, so this checks the half that is the control's.
    a!.focus();
    fireEvent.keyDown(a!, { key: 'Tab' });
    expect(document.activeElement).toBe(c);
    c!.focus();
    fireEvent.keyDown(c!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(a);
  });

  it('moves between options on an arrow key and picks one with Space', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    render3('a', next => changes.push(next));
    const [a, b, c] = screen.getAllByRole('radio');
    a!.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(b);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(c);
    // An arrow moves focus, it does not choose (React Aria's toggle-button
    // group): the choice is Space or Enter on the focused option.
    expect(changes).toEqual([]);
    await user.keyboard(' ');
    expect(changes).toEqual(['c']);
  });

  it('reports which option is chosen', () => {
    render3('b', () => {});
    const checked = screen
      .getAllByRole('radio')
      .filter(o => o.getAttribute('aria-checked') === 'true');
    expect(checked.map(option => option.textContent)).toEqual(['B']);
  });
});
