// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Select } from '../apps/web/src/components/ui/index';

/**
 * A select says what is chosen (024).
 *
 * HeroUI's list item wraps its children, so React Aria could not derive the
 * chosen row's text, and every inventory select holding a value drew an empty
 * trigger. Found on the beta, on a task's status at phone width.
 */
afterEach(cleanup);

describe('Select', () => {
  it('shows the label of the chosen option', () => {
    const { container } = render(
      <Select
        aria-label="Status"
        value="in_progress"
        options={[
          { value: 'todo', label: 'To do' },
          { value: 'in_progress', label: 'In progress' }
        ]}
        onChange={() => undefined}
      />
    );
    expect(container.querySelector('.ui-select-value')?.textContent).toBe('In progress');
  });

  it('shows the placeholder while nothing is chosen', () => {
    const { container } = render(
      <Select
        aria-label="Assignee"
        value=""
        placeholder="Not assigned"
        options={[{ value: 'u1', label: 'Olena' }]}
        onChange={() => undefined}
      />
    );
    expect(container.querySelector('.ui-select-value')?.textContent).toBe('Not assigned');
  });
});
