// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PictoToggle } from '../apps/web/src/components/ui/index';
import { TaskFiltersButton } from '../apps/web/src/team/tasks/TaskFiltersButton';
import { TaskDateFilterControl } from '../apps/web/src/team/tasks/TaskDateFilter';
import { TaskProgressScale } from '../apps/web/src/team/tasks/TaskProgressScale';
import { TaskStatusControl } from '../apps/web/src/team/tasks/TaskStatusControl';
import { TaskLabelMenu } from '../apps/web/src/team/labels/TaskLabelMenu';
import { TaskLabelColorPicker } from '../apps/web/src/team/labels/TaskLabelChip';
import { WorkspaceChip } from '../apps/web/src/team/workspace/WorkspaceChip';
import { FinanceCopyMenu } from '../apps/web/src/team/accounts/finance/FinanceActions';
import { LaunchListFilter } from '../apps/web/src/team/launches/LaunchListFilter';

/**
 * 070 phase 8б: the board's, the launch list's, the tags', the finance panel's and the header's
 * controls on the inventory — read by role, as a person with a screen reader meets them.
 */

afterEach(cleanup);

describe('«Filters»', () => {
  it('is named by how many filters are on, and opens its panel', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TaskFiltersButton count={0}>
        <p>inside</p>
      </TaskFiltersButton>
    );
    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Filters' })).toBeTruthy();
    expect(screen.getByText('inside')).toBeTruthy();

    rerender(
      <TaskFiltersButton count={2}>
        <p>inside</p>
      </TaskFiltersButton>
    );
    expect(screen.getByRole('button', { name: 'Filters, 2 on' })).toBeTruthy();
  });
});

describe('the date chip', () => {
  it('says «Date» until a range is on, and puts the presets above the month', async () => {
    const user = userEvent.setup();
    render(
      <TaskDateFilterControl
        value={{ kind: 'all' }}
        onChange={vi.fn()}
        status="all"
        onStatusChange={vi.fn()}
        showStatus={false}
        inlineDays
        inlineTomorrow
      />
    );
    const trigger = screen.getByRole('button', { name: 'Open calendar' });
    expect(trigger.textContent).toContain('Date');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Date' });
    const presets = within(dialog)
      .getAllByRole('button')
      .filter(button => button.classList.contains('task-date-preset'))
      .map(button => button.textContent);
    expect(presets).toEqual(['Yesterday', 'Today', 'Tomorrow', 'This month', 'All time']);
    const grid = within(dialog).getByRole('grid');
    const firstPreset = within(dialog).getByRole('button', { name: 'Yesterday' });
    expect(firstPreset.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('asks for a status as one of four radios', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    render(
      <TaskDateFilterControl
        value={{ kind: 'all' }}
        onChange={vi.fn()}
        status="all"
        onStatusChange={onStatusChange}
      />
    );
    const group = screen.getByRole('radiogroup', { name: 'Status' });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe(
      'true'
    );
    await user.click(within(group).getByRole('radio', { name: 'In progress' }));
    expect(onStatusChange).toHaveBeenCalledWith('in_progress');
  });
});

describe('the progress on a card', () => {
  it('draws no number at zero and the count after the groove once there is one', () => {
    const { container, rerender } = render(
      <TaskProgressScale quiet value={0} max={10} onChange={vi.fn()} label="Progress" />
    );
    const slider = screen.getByRole('slider', { name: 'Progress' });
    expect(slider.textContent).toBe('');
    expect(container.querySelector('.team-task-progress-value')).toBeNull();

    rerender(<TaskProgressScale quiet value={3} max={10} onChange={vi.fn()} label="Progress" />);
    expect(screen.getByRole('slider').textContent).toBe('');
    expect(container.querySelector('.team-task-progress-value')?.textContent).toBe('3/10');
  });

  it('keeps the numbered knob in the editor', () => {
    render(<TaskProgressScale value={4} max={10} onChange={vi.fn()} label="Progress" />);
    expect(screen.getByRole('slider').textContent).toBe('4');
  });
});

describe('the status on a card', () => {
  it('is three pressable states, and a reader sees them without being able to press', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<TaskStatusControl value="todo" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'To do' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenCalledWith('done');

    rerender(<TaskStatusControl value="todo" onChange={onChange} disabled />);
    expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('the tag list', () => {
  const labels = [
    { id: 'a', name: 'Alpha', color: 'blue' as const },
    { id: 'b', name: 'Beta', color: 'red' as const }
  ];

  it('is a list of options answered by Enter and Space, not a column of buttons', () => {
    const onToggle = vi.fn();
    render(
      <TaskLabelMenu
        labels={labels}
        selectedIds={new Set(['b'])}
        onToggle={onToggle}
        ariaLabel="Tags"
        emptyText="None"
      />
    );
    const list = screen.getByRole('listbox', { name: 'Tags' });
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]!.tagName).toBe('DIV');
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(options[0]!, { key: 'Enter' });
    expect(onToggle).toHaveBeenLastCalledWith(labels[0], true);
    fireEvent.keyDown(options[1]!, { key: ' ' });
    expect(onToggle).toHaveBeenLastCalledWith(labels[1], false);
  });

  it('answers nothing while it is disabled', () => {
    const onToggle = vi.fn();
    render(
      <TaskLabelMenu
        labels={labels}
        selectedIds={new Set()}
        onToggle={onToggle}
        ariaLabel="Tags"
        emptyText="None"
        disabled
      />
    );
    const option = screen.getAllByRole('option')[0]!;
    expect(option.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(option);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('offers a tag’s colour as one radio of nine', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskLabelColorPicker value="purple" onChange={onChange} />);
    expect(screen.getAllByRole('radio')).toHaveLength(9);
    expect(screen.getByRole('radio', { name: 'Purple' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(onChange).toHaveBeenCalledWith('blue');
  });
});

describe('the header’s chip', () => {
  it('is a button named in full whose words are a live region', async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(
      <WorkspaceChip tone="warn" label="Reconnect Drive" onPress={onPress} opensDialog>
        Read only
      </WorkspaceChip>
    );
    const chip = screen.getByRole('button', { name: 'Reconnect Drive' });
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip.classList.contains('ui-chip-warn')).toBe(true);
    expect(chip.querySelector('[aria-live="polite"]')?.textContent).toBe('Read only');
    await user.click(chip);
    expect(onPress).toHaveBeenCalledOnce();
  });
});

describe('copying a period’s top-ups', () => {
  it('is one button with the two ways in its menu', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(<FinanceCopyMenu onCopy={onCopy} />);
    await user.click(screen.getByRole('button', { name: 'Copy top-ups' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy top-ups by tag' }));
    expect(onCopy).toHaveBeenCalledWith('label');
  });
});

describe('a launch list filter', () => {
  it('ticks the answer in force and hands a new one back', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LaunchListFilter
        label="Assignee"
        allLabel="All"
        value="b"
        onChange={onChange}
        options={[
          { value: 'a', label: 'Anna' },
          { value: 'b', label: 'Bohdan' }
        ]}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Assignee' }));
    const bohdan = await screen.findByRole('menuitemradio', { name: 'Bohdan' });
    expect(bohdan.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('menuitemradio', { name: 'Anna' }));
    expect(onChange).toHaveBeenCalledWith('a');
  });
});

describe('PictoToggle', () => {
  it('stays pressable while it cannot act, and draws how far a job has come', () => {
    const onClick = vi.fn();
    render(
      <PictoToggle pressed={false} unavailable fill={0.42} aria-label="Video" onClick={onClick}>
        <svg />
      </PictoToggle>
    );
    const toggle = screen.getByRole('button', { name: 'Video' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.style.getPropertyValue('--ui-picto-fill')).toBe('0.42');
    fireEvent.click(toggle);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('marks the pressed plate and clamps the fill', () => {
    render(
      <PictoToggle pressed fill={3} aria-label="Links">
        <svg />
      </PictoToggle>
    );
    const toggle = screen.getByRole('button', { name: 'Links' });
    expect(toggle.classList.contains('is-selected')).toBe(true);
    expect(toggle.hasAttribute('aria-disabled')).toBe(false);
    expect(toggle.style.getPropertyValue('--ui-picto-fill')).toBe('1');
  });
});
