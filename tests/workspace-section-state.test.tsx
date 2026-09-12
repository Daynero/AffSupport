// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

/**
 * Leaving a section and coming back must not undo what somebody just did.
 *
 * The explorer already worked this way — mounted and hidden rather than
 * unmounted — and the reason was written down: a section change used to reset
 * the open folder and the selection. The other three sections were still
 * conditionally rendered, so a filter set in Tasks, a scroll in Accounts and a
 * half-typed invitation in Members were all discarded by a single click on
 * another tab.
 *
 * The sections are stubbed here on purpose: what is under test is the shell's
 * mounting contract, not what each section renders. A stub that counts its own
 * mounts and holds a value states that contract exactly.
 */

const mounts = { tasks: 0, accounts: 0, members: 0 };

/** A section that remembers something, and says how often it was created. */
function stubSection(name: keyof typeof mounts) {
  return function Section() {
    const [value, setValue] = useState('');
    React.useEffect(() => {
      mounts[name] += 1;
    }, []);
    return (
      <div>
        <label htmlFor={`${name}-filter`}>{name} filter</label>
        <input
          id={`${name}-filter`}
          value={value}
          onChange={event => setValue(event.target.value)}
        />
        <p>{`${name} mounts: ${mounts[name]}`}</p>
      </div>
    );
  };
}

vi.mock('../apps/web/src/team/tasks/TaskSpace', () => ({ TaskSpace: stubSection('tasks') }));
vi.mock('../apps/web/src/team/accounts/AccountSpace', () => ({
  AccountSpace: stubSection('accounts')
}));
vi.mock('../apps/web/src/team/workspace/MembersSection', () => ({
  MembersSection: stubSection('members')
}));

const STORAGE_KEY = 'wishly.active-team.v1';

beforeEach(() => {
  mounts.tasks = 0;
  mounts.accounts = 0;
  mounts.members = 0;
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function enterSpace() {
  const team = makeTeam();
  const client = makeClient({
    listTeams: vi.fn().mockResolvedValue([team]),
    listMaterials: vi.fn().mockResolvedValue([])
  });
  localStorage.setItem(STORAGE_KEY, team.id);
  render(
    <TeamProvider realtime={false}>
      <TeamSpace client={client} directAddMode="disabled" />
    </TeamProvider>
  );
  expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
  return { team, user: userEvent.setup() };
}

const tab = (name: 'Explorer' | 'Tasks' | 'Accounts' | 'Members') =>
  screen.getByRole('link', { name });

describe('switching workspace sections', () => {
  it('keeps what was typed in a section after a trip to another one', async () => {
    const { user } = await enterSpace();

    await user.click(tab('Tasks'));
    const filter = await screen.findByLabelText('tasks filter');
    await user.type(filter, 'geo:ua');
    expect((filter as HTMLInputElement).value).toBe('geo:ua');

    await user.click(tab('Accounts'));
    await screen.findByLabelText('accounts filter');

    await user.click(tab('Tasks'));
    // The same element, with the same value: nothing was thrown away and
    // nothing had to be restored.
    expect((screen.getByLabelText('tasks filter') as HTMLInputElement).value).toBe('geo:ua');
    expect(mounts.tasks).toBe(1);
  });

  it('creates each section once, however often the tabs are used', async () => {
    const { user } = await enterSpace();

    for (const name of ['Tasks', 'Accounts', 'Members'] as const) await user.click(tab(name));
    for (const name of ['Explorer', 'Tasks', 'Accounts', 'Members'] as const)
      await user.click(tab(name));
    await screen.findByLabelText('members filter');

    expect(mounts).toEqual({ tasks: 1, accounts: 1, members: 1 });
  });

  it('does not build a section nobody has opened', async () => {
    await enterSpace();

    // The explorer is the landing section; paying to load the other three for
    // somebody who never leaves it is the cost this mounting rule avoids.
    expect(mounts).toEqual({ tasks: 0, accounts: 0, members: 0 });
  });

  it('hides the sections that are not being looked at', async () => {
    const { user } = await enterSpace();

    await user.click(tab('Tasks'));
    await screen.findByLabelText('tasks filter');
    await user.click(tab('Accounts'));
    await screen.findByLabelText('accounts filter');

    // Still mounted, but out of the page: not visible, and not announced.
    expect(screen.getByLabelText('tasks filter').closest('[hidden]')).toBeTruthy();
    expect(screen.getByLabelText('accounts filter').closest('[hidden]')).toBeNull();
  });

  it('brings the task filter back with the tab that owns it', async () => {
    const { team, user } = await enterSpace();

    // A filter that lives in the address rather than in a component: leaving
    // the section used to drop it, because the tab link was rebuilt empty.
    window.history.pushState(null, '', `/team/${team.id}/tasks?account=acc-7`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByLabelText('tasks filter');
    expect(window.location.search).toBe('?account=acc-7');

    await user.click(tab('Accounts'));
    await screen.findByLabelText('accounts filter');
    expect(window.location.search).toBe('');

    await user.click(tab('Tasks'));
    expect(window.location.search).toBe('?account=acc-7');
  });
});
