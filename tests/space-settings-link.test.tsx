// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SpaceSettingsLink } from '../apps/web/src/team/SpaceSettingsLink';
import { parseTeamRoute } from '../apps/web/src/team/routes';

const state = vi.hoisted(() => ({ team: 'space-a' as string | null, navigate: vi.fn() }));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ activeTeam: state.team ? { id: state.team } : null })
}));
vi.mock('../apps/web/src/lib/navigation', async original => ({
  ...(await original<typeof import('../apps/web/src/lib/navigation')>()),
  navigateTo: state.navigate
}));
afterEach(() => {
  cleanup();
  state.team = 'space-a';
  state.navigate.mockClear();
  window.history.replaceState(null, '', '/');
});

it('opens settings over the current task and preserves browser modified-click semantics', () => {
  window.history.replaceState(null, '', '/team/space-a/tasks?task=task-a');
  render(<SpaceSettingsLink target={{ kind: 'settings', tab: 'tags' }} />);
  const link = screen.getByRole('link', { name: 'Space settings' });
  const href = link.getAttribute('href')!;
  expect(parseTeamRoute(href)).toMatchObject({
    spaceId: 'space-a',
    section: 'tasks',
    query: { taskId: 'task-a', settings: true, settingsTab: 'tags' }
  });
  // Observe React's decision before preventing jsdom from attempting real navigation.
  const prevented: boolean[] = [];
  const observe = (event: MouseEvent) => {
    prevented.push(event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener('click', observe);
  try {
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])
      fireEvent.click(link, { [modifier]: true });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(prevented).toEqual([false, false, false, false]);
    fireEvent.click(link);
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith(href);
    expect(prevented.at(-1)).toBe(true);
  } finally {
    document.removeEventListener('click', observe);
  }
});

it('has no destination without an active space and accepts a specific section label', () => {
  state.team = null;
  const view = render(<SpaceSettingsLink target={{ kind: 'section', section: 'explorer' }} />);
  expect(screen.queryByRole('link')).toBeNull();
  state.team = 'space-b';
  view.rerender(
    <SpaceSettingsLink target={{ kind: 'section', section: 'explorer' }} label="Open files" />
  );
  expect(screen.getByRole('link', { name: 'Open files' }).getAttribute('href')).toBe(
    '/team/space-b'
  );
});
