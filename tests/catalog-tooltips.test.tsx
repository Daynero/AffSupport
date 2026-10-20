// @vitest-environment jsdom
import React, { createRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Tooltip } from '../apps/web/src/components/ui/Feedback';
import { CatalogIconControls } from '../apps/web/src/team/catalog-updater/CatalogIconControls';

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it('keeps both the child ref and the tooltip anchor attached to one native button', async () => {
  const ref = createRef<HTMLButtonElement>();
  render(
    <Tooltip asChild delay={0} label="Change links">
      <button ref={ref}>Links</button>
    </Tooltip>
  );
  const button = screen.getByRole('button', { name: 'Links' });
  expect(ref.current).toBe(button);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  fireEvent.pointerMove(button, { pointerType: 'mouse' });
  fireEvent.mouseMove(button);
  await userEvent.hover(button);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Change links');
  expect(button.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
});

it('dismisses on a click without pointer events and preserves the child action', async () => {
  const action = vi.fn();
  render(
    <Tooltip asChild delay={0} label="Change links">
      <button onClick={action}>Links</button>
    </Tooltip>
  );
  const button = screen.getByRole('button', { name: 'Links' });
  fireEvent.pointerMove(button, { pointerType: 'mouse' });
  fireEvent.mouseMove(button);
  await userEvent.hover(button);
  await screen.findByRole('tooltip');
  fireEvent.click(button);
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
});

it('replaces a hovered tooltip and closes all catalog hints while a setting saves', async () => {
  const profile = {
    catalogId: 'catalog-1',
    refreshImages: true,
    refreshTexts: true,
    growProducts: false,
    randomLinkVariation: true,
    restitch: false,
    version: 1,
    updatedAt: '2026-10-19T10:00:00Z'
  };
  const onChange = vi.fn();
  const view = render(<CatalogIconControls profile={profile} name="Test" onChange={onChange} />);
  const buttons = screen.getAllByRole('button');
  fireEvent.pointerMove(buttons[1], { pointerType: 'mouse' });
  fireEvent.mouseMove(buttons[1]);
  await userEvent.hover(buttons[1]);
  await screen.findByRole('tooltip');
  await userEvent.unhover(buttons[1]);
  await userEvent.hover(buttons[2]);
  await waitFor(() => expect(screen.getAllByRole('tooltip')).toHaveLength(1));
  view.rerender(
    <CatalogIconControls
      profile={profile}
      name="Test"
      onChange={onChange}
      state={{ phase: 'pending', field: 'refreshImages', intended: false }}
      disabledReason="Saving"
    />
  );
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  await userEvent.unhover(buttons[2]);
  await userEvent.hover(buttons[3]);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(5);
});

it('preserves keyboard focus and Escape for the inventory span trigger', async () => {
  render(
    <Tooltip delay={0} label="Keyboard help">
      <span>Help glyph</span>
    </Tooltip>
  );
  await userEvent.tab();
  expect((await screen.findByRole('tooltip')).textContent).toBe('Keyboard help');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
});

it('closes a component tooltip when a nonmodal schedule panel appears', async () => {
  const { rerender } = render(
    <Tooltip asChild delay={0} label="Old hint">
      <button>Toggle</button>
    </Tooltip>
  );
  const button = screen.getByRole('button', { name: 'Toggle' });
  fireEvent.pointerMove(button, { pointerType: 'mouse' });
  fireEvent.mouseMove(button);
  await userEvent.hover(button);
  await screen.findByRole('tooltip');
  rerender(
    <>
      <Tooltip asChild delay={0} label="Old hint">
        <button>Toggle</button>
      </Tooltip>
      <div role="dialog" aria-label="Schedule">
        <button>Save</button>
      </div>
    </>
  );
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
});
