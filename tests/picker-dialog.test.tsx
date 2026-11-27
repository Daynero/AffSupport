// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PickerDialog, type PickerItem } from '../apps/web/src/components/ui/index';

const ITEMS: PickerItem[] = [
  { id: 'folder', title: 'Campaigns', branch: true },
  { id: 'a', title: 'alpha.mp4', thumbnailUrl: 'https://thumbs.test/a.jpg' },
  { id: 'b', title: 'beta.mp4', disabled: true, subtitle: 'Already added' },
  { id: 'c', title: 'gamma.png' }
];

function Harness({
  mode = 'multiple',
  onPick = vi.fn(),
  onConfirm = vi.fn(),
  items = ITEMS,
  views = ['list', 'grid'] as const
}: {
  mode?: 'multiple' | 'single' | 'commit';
  onPick?: (item: PickerItem) => void;
  onConfirm?: () => void;
  items?: PickerItem[];
  views?: readonly ('list' | 'grid')[];
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <PickerDialog
      title="Choose files"
      onClose={vi.fn()}
      closeLabel="Close"
      mode={mode}
      search={{ value: query, onChange: setQuery, placeholder: 'Search', clearLabel: 'Clear' }}
      views={views}
      viewKey="test"
      viewLabels={{ label: 'View', list: 'List', grid: 'Tiles' }}
      items={items}
      loadingLabel="Loading"
      empty={{ title: 'Nothing here' }}
      selected={selected}
      onPick={item => {
        onPick(item);
        if (item.branch || mode === 'commit') return;
        setSelected(current => {
          const next = new Set(mode === 'single' ? [] : current);
          if (current.has(item.id)) next.delete(item.id);
          else next.add(item.id);
          return next;
        });
      }}
      footer={
        mode === 'commit'
          ? undefined
          : {
              cancelLabel: 'Cancel',
              confirmLabel: `Add ${selected.size}`,
              confirmDisabled: selected.size === 0,
              onConfirm
            }
      }
    />
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('075 — PickerDialog', () => {
  it('opens on its search, lists options, and ticks with a press', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const search = screen.getByRole('combobox', { name: 'Search' });
    expect(document.activeElement).toBe(search);
    const list = screen.getByRole('listbox', { name: 'Choose files' });
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    expect(within(list).getAllByRole('option')).toHaveLength(4);
    await userEvent.click(screen.getByRole('option', { name: /alpha\.mp4/ }));
    expect(screen.getByRole('option', { name: /alpha\.mp4/ }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.getByRole('button', { name: 'Add 1' })).toHaveProperty('disabled', false);
  });

  it('does not pick a disabled option', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(screen.getByRole('option', { name: /beta\.mp4/ }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('moves with the arrows and picks with Enter; ⌘Enter confirms', async () => {
    const onPick = vi.fn();
    const onConfirm = vi.fn();
    render(<Harness onPick={onPick} onConfirm={onConfirm} />);
    const search = screen.getByRole('combobox', { name: 'Search' });
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }));
    expect(search.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('chooses on the first pick in commit mode, with no footer', async () => {
    const onPick = vi.fn();
    render(<Harness mode="commit" onPick={onPick} />);
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'folder' }));
  });

  it('switches to tiles with pictures and remembers the choice', async () => {
    const view = render(<Harness />);
    await userEvent.click(screen.getByRole('radio', { name: 'Tiles' }));
    const list = screen.getByRole('listbox');
    expect(list.dataset.view).toBe('grid');
    expect(list.querySelector('img')?.getAttribute('src')).toBe('https://thumbs.test/a.jpg');
    expect(localStorage.getItem('soty.picker.view.test')).toBe('grid');
    view.unmount();
    render(<Harness />);
    expect(screen.getByRole('listbox').dataset.view).toBe('grid');
  });

  it('says when there is nothing', () => {
    render(<Harness items={[]} />);
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
