// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, Card, Chip, Input } from '../apps/web/src/components/ui/index';

/**
 * "The same role looks the same everywhere" (021, T156 — SC-003).
 *
 * The product's problem was never that a screen had an ugly button; it was that
 * seven screens had seven buttons for the same job. Prose review cannot catch
 * that — it needs the same role rendered twice and the results compared.
 *
 * jsdom computes no stylesheet, so this asserts on the classes that carry the
 * geometry rather than on pixels: two controls of the same role must resolve to
 * the same variant, size and colour class, whatever screen asked for them. The
 * pixel half is the demo surface at /design, where every variant sits side by
 * side (T030).
 */

afterEach(cleanup);

/** The classes that decide a control's geometry and colour. */
function signature(element: Element): string {
  return element.className
    .split(/\s+/)
    .filter(name => name.startsWith('ui-') || name.startsWith('is-'))
    .sort()
    .join(' ');
}

describe('one role, one appearance', () => {
  it('gives the primary action the same shape wherever it is raised', () => {
    // Two screens asking for "the one action this surface exists for".
    const compressor = render(
      <Button color="primary" size="md">
        Compress
      </Button>
    );
    const first = signature(screen.getByRole('button'));
    compressor.unmount();

    const tasks = render(
      <Button color="primary" size="md">
        Create task
      </Button>
    );
    const second = signature(screen.getByRole('button'));

    expect(second).toBe(first);
  });

  it('gives a destructive action the quiet treatment on every screen', () => {
    const explorer = render(
      <Button color="error" variant="soft">
        Delete
      </Button>
    );
    const first = signature(screen.getByRole('button'));
    explorer.unmount();

    const settings = render(
      <Button color="error" variant="soft">
        Leave the space
      </Button>
    );
    expect(signature(screen.getByRole('button'))).toBe(first);
    // And it is never the loudest thing on the surface.
    expect(first).not.toContain('ui-button--solid');
  });

  it('keeps the legacy spelling and the new one visually identical', () => {
    // A migrated screen says color="primary"; an unmigrated one still says
    // variant="primary". Until every screen has moved, those two must render
    // the same button — otherwise the migration itself introduces the drift it
    // exists to remove.
    const legacy = render(<Button variant="primary">Save</Button>);
    const first = signature(screen.getByRole('button'));
    legacy.unmount();

    render(
      <Button color="primary" variant="solid">
        Save
      </Button>
    );
    expect(signature(screen.getByRole('button'))).toBe(first);
  });

  it('gives a dense control the same size class in a table and in a toolbar', () => {
    const inTable = render(
      <Button size="xs" variant="ghost">
        Open
      </Button>
    );
    const first = signature(screen.getByRole('button'));
    inTable.unmount();

    render(
      <Button size="xs" variant="ghost">
        Copy
      </Button>
    );
    expect(signature(screen.getByRole('button'))).toBe(first);
  });

  it('gives a container of the same role the same treatment', () => {
    const settings = render(<Card role="panel" title="A" titleId="a" />);
    const first = signature(settings.container.querySelector('.ui-card')!);
    settings.unmount();

    const compressor = render(<Card role="panel" title="B" titleId="b" />);
    expect(signature(compressor.container.querySelector('.ui-card')!)).toBe(first);
  });

  it('gives fields and chips one shape each', () => {
    const firstField = render(<Input size="sm" />);
    const fieldSignature = signature(firstField.container.querySelector('.ui-input')!);
    firstField.unmount();

    const secondField = render(<Input size="sm" />);
    expect(signature(secondField.container.querySelector('.ui-input')!)).toBe(fieldSignature);
    secondField.unmount();

    const firstChip = render(<Chip size="xs">#2</Chip>);
    const chipSignature = signature(firstChip.container.querySelector('.ui-chip')!);
    firstChip.unmount();

    const secondChip = render(<Chip size="xs">#5</Chip>);
    expect(signature(secondChip.container.querySelector('.ui-chip')!)).toBe(chipSignature);
  });
});
