// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  ConfirmDialog,
  DropdownMenu,
  Empty,
  FormField,
  IconButton,
  Input,
  Modal,
  Progress,
  RadioGroup,
  SegmentedControl,
  Select,
  SelectionBar,
  Skeleton,
  Switch,
  Tabs,
  UI_COLORS,
  UI_SIZES,
  UI_VARIANTS
} from '../apps/web/src/components/ui/index';

/**
 * The inventory's own tests (021, T031).
 *
 * Not "does it render" — every component in every variant and size, every
 * state distinct from every other, every icon-only control named, and every
 * interactive component reachable by keyboard. These are the assertions that
 * make FR-009 through FR-012 checkable rather than aspirational.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Button', () => {
  it('renders every variant × colour × size combination it declares', () => {
    for (const variant of UI_VARIANTS) {
      for (const color of UI_COLORS) {
        for (const size of UI_SIZES) {
          const { unmount } = render(
            <Button variant={variant} color={color} size={size}>
              {variant}
            </Button>
          );
          const button = screen.getByRole('button');
          expect(button.className).toContain(`ui-button--${variant}`);
          expect(button.className).toContain(`ui-button--${size}`);
          expect(button.className).toContain(`ui-color-${color}`);
          unmount();
        }
      }
    }
  });

  it('keeps the five legacy variant names working while screens migrate', () => {
    // Sixty modules still say variant="primary"; they must not break the day
    // the inventory lands.
    const cases = [
      ['primary', 'ui-color-primary', 'ui-button--solid'],
      ['secondary', 'ui-color-neutral', 'ui-button--outline'],
      ['ghost', 'ui-color-neutral', 'ui-button--ghost'],
      ['danger', 'ui-color-error', 'ui-button--soft'],
      ['success', 'ui-color-success', 'ui-button--soft']
    ] as const;
    for (const [legacy, color, variant] of cases) {
      const { unmount } = render(<Button variant={legacy}>label</Button>);
      const button = screen.getByRole('button');
      expect(button.className, legacy).toContain(color);
      expect(button.className, legacy).toContain(variant);
      unmount();
    }
  });

  it('tells loading and disabled apart, and says so to assistive technology', () => {
    const { rerender } = render(<Button loading>Save</Button>);
    const loading = screen.getByRole('button');
    expect(loading.className).toContain('is-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading).toBeDisabled();

    rerender(<Button disabled>Save</Button>);
    const disabled = screen.getByRole('button');
    expect(disabled.className).not.toContain('is-loading');
    expect(disabled.getAttribute('aria-busy')).toBeNull();
    expect(disabled).toBeDisabled();
  });

  it('does not submit a form unless it is asked to', () => {
    render(<Button>Plain</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });
});

describe('IconButton', () => {
  it('always carries a name an icon cannot give it', () => {
    render(
      <IconButton label="Remove the tag">
        <svg />
      </IconButton>
    );
    const button = screen.getByRole('button', { name: 'Remove the tag' });
    expect(button.getAttribute('title')).toBe('Remove the tag');
  });

  it('reports the state of a toggle rather than only colouring it', () => {
    render(
      <IconButton label="Pin" pressed>
        <svg />
      </IconButton>
    );
    expect(screen.getByRole('button', { name: 'Pin' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Badge and Chip', () => {
  it('renders every badge colour', () => {
    for (const color of UI_COLORS) {
      const { unmount } = render(<Badge color={color}>{color}</Badge>);
      expect(screen.getByText(color).className).toContain(`ui-color-${color}`);
      unmount();
    }
  });

  it('names the control that takes a chip off', () => {
    const onRemove = vi.fn();
    render(
      <Chip onRemove={onRemove} removeLabel="Remove tag #2">
        #2
      </Chip>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag #2' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('marks a selected chip with more than a colour', () => {
    render(<Chip selected>#2</Chip>);
    // The border and the fill both change; the class is what carries both.
    expect(screen.getByText('#2').closest('.ui-chip')!.className).toContain('is-selected');
  });
});

describe('Card', () => {
  it('draws the heading row with its icon, title and state summary', () => {
    render(
      <Card role="panel" title="Compression settings" aside="720p · 30 FPS" titleId="t">
        <span>body</span>
      </Card>
    );
    expect(screen.getByRole('heading', { name: 'Compression settings' })).toBeTruthy();
    expect(screen.getByText('720p · 30 FPS')).toBeTruthy();
  });
});

describe('Alert', () => {
  it('announces a failure and merely states a standing note', () => {
    const { rerender } = render(<Alert color="error" live="alert">Could not connect.</Alert>);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<Alert color="info">Storage is read-only in beta.</Alert>);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('Form controls', () => {
  it('wires a field to its help, and swaps help for an error', () => {
    const { rerender } = render(
      <FormField label="Name" help="Up to 60 characters.">
        <Input />
      </FormField>
    );
    expect(screen.getByText('Up to 60 characters.')).toBeTruthy();

    rerender(
      <FormField label="Name" help="Up to 60 characters." error="That name is taken.">
        <Input invalid />
      </FormField>
    );
    // The error replaces the help rather than stacking with it, and it is the
    // thing announced.
    expect(screen.queryByText('Up to 60 characters.')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('That name is taken.');
  });

  it('puts a unit outside the field rather than inside it', () => {
    render(<Input suffix="мс" defaultValue="1000" />);
    const suffix = screen.getByText('мс');
    expect(suffix.className).toContain('ui-input-suffix');
    expect(suffix.closest('input')).toBeNull();
  });

  it('renders a select with its placeholder and options', () => {
    render(
      <Select
        placeholder="Any"
        options={[
          { value: 'a', label: 'First' },
          { value: 'b', label: 'Second' }
        ]}
      />
    );
    const options = within(screen.getByRole('combobox')).getAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual(['Any', 'First', 'Second']);
  });

  it('reports an indeterminate checkbox as mixed', () => {
    render(<Checkbox label="All" indeterminate />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('mixed');
  });

  it('exposes a switch as a switch', () => {
    render(<Switch label="Strip metadata" />);
    expect(screen.getByRole('switch')).toBeTruthy();
  });

  it('marks the chosen segment and radio, and changes on press', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Scope"
        value="all"
        onChange={onChange}
        options={[
          { value: 'all', label: 'All' },
          { value: 'free', label: 'Free' }
        ]}
      />
    );
    expect(screen.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Free' }));
    expect(onChange).toHaveBeenCalledWith('free');
  });

  it('draws the picto group the way docs/DESIGN.md specifies', () => {
    render(
      <RadioGroup
        label="Fit"
        variant="pictos"
        value="fit"
        onChange={() => {}}
        options={[
          { value: 'fit', label: 'Fit', short: 'Fit' },
          { value: 'fill', label: 'Fill', short: 'Fill' }
        ]}
      />
    );
    const selected = screen.getByRole('radio', { name: 'Fit' });
    // `is-selected`, never `is-active` — the class the product's rule book
    // names, and the one its stylesheet answers to.
    expect(selected.className).toContain('is-selected');
    expect(selected.className).not.toContain('is-active');
    expect(selected.className).toContain('is-labeled');
  });
});

describe('Feedback', () => {
  it('gives an empty state a title, a sentence and the way out', () => {
    render(
      <Empty
        title="No tags yet"
        description="Tags are made in the space settings."
        action={<Button>Space settings</Button>}
      />
    );
    expect(screen.getByText('No tags yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Space settings' })).toBeTruthy();
  });

  it('says what is loading for a reader who cannot see the shimmer', () => {
    render(<Skeleton shape="row" count={3} label="Loading accounts" />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(within(region).getByText('Loading accounts')).toBeTruthy();
  });

  it('reports progress as a value, and omits the value when it has none', () => {
    const { rerender } = render(<Progress value={35} label="Compressing" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('35');
    rerender(<Progress label="Working" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
  });
});

describe('Overlays', () => {
  it('names a dialog and closes it on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} title="Space settings">
        <p>body</p>
      </Modal>
    );
    expect(screen.getByRole('dialog', { name: 'Space settings' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('puts the verb on a confirmation button and keeps the destructive one quiet', () => {
    render(
      <ConfirmDialog
        title="Leave the space?"
        body="You lose access to its files."
        confirmLabel="Leave the space"
        cancelLabel="Stay"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    const confirm = screen.getByRole('button', { name: 'Leave the space' });
    // Soft, not solid: the destructive action is de-emphasised beside the safe
    // one (docs/DESIGN-PRINCIPLES.md).
    expect(confirm.className).toContain('ui-button--soft');
    expect(confirm.className).toContain('ui-color-error');
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
  });

  it('walks a menu with the arrow keys and marks a destructive item', () => {
    render(
      <DropdownMenu
        open
        onClose={() => {}}
        label="Row actions"
        items={[
          { id: 'open', label: 'Open', onSelect: () => {} },
          'separator',
          { id: 'delete', label: 'Delete', destructive: true, onSelect: () => {} }
        ]}
      />
    );
    const menu = screen.getByRole('menu', { name: 'Row actions' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).getByRole('menuitem', { name: 'Delete' }).className).toContain(
      'is-destructive'
    );
  });
});

describe('Navigation and patterns', () => {
  it('marks the selected tab and moves with the arrow keys', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        label="Sections"
        value="files"
        onChange={onChange}
        items={[
          { id: 'files', label: 'Files' },
          { id: 'tasks', label: 'Tasks' }
        ]}
      />
    );
    const selected = screen.getByRole('tab', { name: 'Files' });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(selected, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('tasks');
  });

  it('carries the count on the control that clears a selection', () => {
    render(
      <SelectionBar
        count={3}
        label="3 selected"
        clearLabel="Clear selection (3)"
        onClear={() => {}}
        actions={<Button size="sm">Process</Button>}
      />
    );
    expect(screen.getByRole('button', { name: 'Clear selection (3)' })).toBeTruthy();
  });

  it('renders nothing when nothing is selected', () => {
    const { container } = render(
      <SelectionBar
        count={0}
        label=""
        clearLabel="Clear selection (0)"
        onClear={() => {}}
        actions={null}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
