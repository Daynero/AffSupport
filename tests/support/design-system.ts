import { expect } from 'vitest';

/**
 * Asking a control what it means, rather than what it is called (021, T038/T045).
 *
 * Tests used to assert `className` contained `button-primary`. That is the
 * pre-021 spelling of one role; a migrated screen says `ui-button--solid` with
 * `ui-color-primary`, and the two render the same button by design. Asserting
 * either spelling makes the test fail on a migration that changed nothing a
 * person can see.
 *
 * These read the role through whichever vocabulary the control was written in,
 * so a screen can move without its test moving with it.
 */

function classes(element: Element): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

/** The one action a surface exists for: honey, filled. */
export function isPrimaryAction(element: Element): boolean {
  const names = classes(element);
  if (names.includes('button-primary')) return true;
  return names.includes('ui-button--solid') && names.includes('ui-color-primary');
}

/** The workhorse beside it: bordered, neutral. */
export function isSecondaryAction(element: Element): boolean {
  const names = classes(element);
  if (names.includes('button-secondary')) return true;
  return names.includes('ui-button--outline') && names.includes('ui-color-neutral');
}

/** De-emphasised on purpose — a destructive action is never the loudest thing. */
export function isDestructiveAction(element: Element): boolean {
  const names = classes(element);
  if (names.includes('button-danger')) return true;
  return names.includes('ui-color-error') && !names.includes('ui-button--solid');
}

export function expectPrimaryAction(element: Element): void {
  expect(isPrimaryAction(element), `expected the primary action, got: ${element.className}`).toBe(
    true
  );
}

export function expectSecondaryAction(element: Element): void {
  expect(isSecondaryAction(element), `expected a secondary action, got: ${element.className}`).toBe(
    true
  );
}
