import type { KeyboardEvent } from 'react';

/**
 * Escape inside a search field, decided rather than left to the browser (024).
 *
 * A `type="search"` field swallows Escape in Chrome to clear itself, and a dialog whose search
 * box has the focus — which is where a dialog with one puts it — stopped closing on Escape. The
 * rule here is the one every desktop app follows: a field with something in it is emptied, an
 * empty field lets the dialog close.
 */
export function searchFieldEscape(
  value: string,
  clear: () => void,
  close?: () => void
): (event: KeyboardEvent<HTMLInputElement>) => void {
  return event => {
    if (event.key !== 'Escape') return;
    if (value.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      clear();
      return;
    }
    if (!close) return;
    event.preventDefault();
    close();
  };
}
