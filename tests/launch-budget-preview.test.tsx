// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LaunchBudgetPreview } from '../apps/web/src/team/launches/LaunchBudgetPreview';

// next QA 2026-11-21: six automatic budgets read «10$ 14$ 18$ 22$ +2» with half the row
// empty. Every budget that fits is shown; «+N» only stands for those that do not.

let room = 0;
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-budget')) return 40;
      if (this.hasAttribute('data-more')) return 30;
      return 0;
    }
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      return this.classList.contains('launch-editor-budget-fit') ? room : 0;
    }
  });
});
afterEach(() => {
  cleanup();
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
  if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth);
});

const preview = () =>
  render(
    <LaunchBudgetPreview
      budgets={[10, 14, 18, 22, 26, 30]}
      label="Budget"
      moreLabel={count => `${count} more budgets`}
    />
  );
const shown = () =>
  Array.from(
    document.querySelectorAll('.launch-editor-budget-preview > span'),
    node => node.textContent
  );

it('shows every budget when the line holds them all', () => {
  room = 400;
  preview();
  expect(shown()).toEqual(['10 $', '14 $', '18 $', '22 $', '26 $', '30 $']);
  expect(screen.queryByLabelText(/more budgets/u)).toBeNull();
});

it('folds only what does not fit into «+N», keeping room for the badge', () => {
  room = 200;
  preview();
  expect(shown()).toEqual(['10 $', '14 $', '18 $', '22 $', '+2']);
  const more = screen.getByLabelText('2 more budgets');
  expect(more.getAttribute('title')).toBe('26$ · 30$');
});

it('keeps the measuring copy out of reach of assistive technology', () => {
  room = 400;
  preview();
  expect(document.querySelector('.launch-editor-budget-ruler')?.getAttribute('aria-hidden')).toBe(
    'true'
  );
});
