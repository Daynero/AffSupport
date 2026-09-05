// @vitest-environment jsdom
import React from 'react';
import {
  cleanup,
  fireEvent,
  render as renderRaw,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_ROLE_PERMISSIONS, type TeamAccountSummary } from '@video-compressor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { AccountSpace, type AccountSpaceClient } from '../apps/web/src/team/accounts';

/**
 * The Accounts section (017) against a stubbed client: what the list shows,
 * what the filters hide, how a run is written and cleared in place, and what a
 * viewer cannot do.
 */

const TEAM_ID = '17000000-0000-4000-8000-000000000010';
const V31 = '17000000-0000-4000-8000-000000000031';
const V3 = '17000000-0000-4000-8000-000000000003';
const V12 = '17000000-0000-4000-8000-000000000012';
const STAMP = '2026-09-05T10:00:00.000Z';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

let sequence = 0;
/** An agent with zero or one run — the fixtures' shapes; more come from the client. */
function agent(accountId: string, agentId: string, note: string | null) {
  sequence += 1;
  const id = `${accountId.slice(0, -4)}a${String(sequence).padStart(3, '0')}`;
  return {
    id,
    accountId,
    teamId: TEAM_ID,
    agentId,
    runs: note === null ? [] : [{ id: `${id}-run1`, note, createdAt: STAMP }],
    taskCount: 0,
    createdAt: STAMP,
    updatedAt: STAMP
  };
}

function fixture(): TeamAccountSummary[] {
  return [
    {
      id: V31,
      teamId: TEAM_ID,
      name: 'v31',
      createdAt: STAMP,
      updatedAt: STAMP,
      agents: [
        agent(V31, '1000098765434', 'Pro Caps | TR 02/09'),
        agent(V31, '1000098765401', null)
      ]
    },
    {
      id: V3,
      teamId: TEAM_ID,
      name: 'v3',
      createdAt: STAMP,
      updatedAt: STAMP,
      agents: [agent(V3, '1000011122211', 'Slim Fit | DE 01/09')]
    },
    {
      id: V12,
      teamId: TEAM_ID,
      name: 'v12',
      createdAt: STAMP,
      updatedAt: STAMP,
      agents: []
    }
  ];
}

function client(accounts: TeamAccountSummary[] = fixture()): AccountSpaceClient {
  return {
    listAccounts: vi.fn().mockResolvedValue(accounts),
    createAccount: vi.fn(async ({ name }) => ({
      id: '17000000-0000-4000-8000-000000000099',
      teamId: TEAM_ID,
      name,
      createdAt: STAMP,
      updatedAt: STAMP,
      agents: []
    })),
    renameAccount: vi.fn(async ({ accountId, name }) => ({
      id: accountId,
      teamId: TEAM_ID,
      name,
      createdAt: STAMP,
      updatedAt: STAMP
    })),
    deleteAccount: vi.fn().mockResolvedValue(true),
    addAccountAgent: vi.fn(async ({ accountId, agentId, note }) =>
      agent(accountId, agentId, note ?? null)
    ),
    updateAccountAgent: vi.fn(async ({ agentRowId, agentId }) => {
      const existing = accounts.flatMap(item => item.agents).find(item => item.id === agentRowId)!;
      return { ...existing, agentId, updatedAt: '2026-09-05T11:00:00.000Z' };
    }),
    deleteAccountAgent: vi.fn().mockResolvedValue(true),
    // Runs live in the closure, so add / edit / delete / clear round-trip.
    addAgentRun: vi.fn(async ({ agentRowId, note }) => {
      const existing = accounts.flatMap(item => item.agents).find(item => item.id === agentRowId)!;
      existing.runs = [
        ...existing.runs,
        { id: `${agentRowId}-run${existing.runs.length + 1}`, note, createdAt: STAMP }
      ];
      return { ...existing };
    }),
    updateAgentRun: vi.fn(async ({ runId, note }) => {
      const existing = accounts
        .flatMap(item => item.agents)
        .find(item => item.runs.some(run => run.id === runId))!;
      existing.runs = existing.runs.map(run => (run.id === runId ? { ...run, note } : run));
      return { ...existing };
    }),
    deleteAgentRun: vi.fn(async ({ runId }) => {
      const existing = accounts
        .flatMap(item => item.agents)
        .find(item => item.runs.some(run => run.id === runId))!;
      existing.runs = existing.runs.filter(run => run.id !== runId);
      return { ...existing };
    }),
    clearAgentRuns: vi.fn(async ({ agentRowId }) => {
      const existing = accounts.flatMap(item => item.agents).find(item => item.id === agentRowId)!;
      existing.runs = [];
      return { ...existing };
    })
  };
}

function render(api: AccountSpaceClient, role: 'editor' | 'viewer' = 'editor') {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  const team = {
    id: TEAM_ID,
    name: 'Media buyers',
    role,
    permissions: DEFAULT_ROLE_PERMISSIONS[role],
    connectionState: 'connected' as const
  };
  return renderRaw(
    <ToastProvider>
      <TeamProvider initialTeams={[team]} realtime={false}>
        <AccountSpace teamId={TEAM_ID} client={api} />
      </TeamProvider>
    </ToastProvider>
  );
}

/** The account sections, in list order. */
function groups(): HTMLElement[] {
  return screen.getAllByRole('region').filter(region => region.hasAttribute('data-account-id'));
}

function groupNames(): (string | null)[] {
  return groups().map(group => group.querySelector('.team-account-name')?.textContent ?? null);
}

/** Every agent row on screen (editors excluded). */
function rows(): HTMLElement[] {
  return screen.getAllByRole('listitem').filter(row => row.hasAttribute('data-agent-row-id'));
}

async function waitForGroups() {
  await waitFor(() => expect(groups().length).toBeGreaterThan(0));
}

describe('reading the list', () => {
  it('shows accounts in natural order with the tail of each id and the free ones marked', async () => {
    render(client());
    await waitForGroups();
    expect(groupNames()).toEqual(['v3', 'v12', 'v31']);

    const v31 = screen.getByRole('region', { name: 'v31' });
    const agentRows = within(v31)
      .getAllByRole('listitem')
      .filter(row => row.hasAttribute('data-agent-row-id'));
    expect(agentRows).toHaveLength(2);
    // The tail only; the whole id is in the title of the copy button.
    // The tag, never the bare tail: an agent must not read like a second account.
    expect(agentRows[0]?.textContent).toContain('v31-434');
    expect(agentRows[0]?.textContent).not.toContain('1000098765434');
    expect(
      within(agentRows[0]!)
        .getByRole('button', { name: 'Copy full ID v31-434' })
        .getAttribute('title')
    ).toContain('1000098765434');
    expect(agentRows[0]?.getAttribute('data-free')).toBe('false');
    expect(agentRows[1]?.getAttribute('data-free')).toBe('true');
    // The tooltip carries the full id.
    expect(
      within(agentRows[0]!)
        .getByRole('button', { name: 'Copy full ID v31-434' })
        .getAttribute('title')
    ).toContain('1000098765434');
  });

  it('counts agents on the filter chips', async () => {
    render(client());
    await waitForGroups();
    expect(screen.getByRole('button', { name: /^All/ }).textContent).toBe('All3');
    expect(screen.getByRole('button', { name: /^Free/ }).textContent).toBe('Free1');
    expect(screen.getByRole('button', { name: /^Running/ }).textContent).toBe('Running2');
  });

  it('says so when there are no accounts, and offers to add one', async () => {
    render(client([]));
    expect(await screen.findByText('No accounts yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add account' })).toHaveLength(2);
  });
});

describe('handing an id over', () => {
  it('copies the full id on press and marks the button for a moment', async () => {
    // fireEvent, not userEvent: userEvent installs its own clipboard stub.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(client());
    await waitForGroups();
    const button = screen.getByRole('button', { name: 'Copy full ID v31-434' });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith('1000098765434');
    await waitFor(() => expect(button.classList.contains('is-copied')).toBe(true));
    // Still the tail on screen: copying does not reveal.
    expect(button.textContent).not.toContain('1000098765434');
  });

  it('reveals the full id and says so when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(client());
    await waitForGroups();
    const button = screen.getByRole('button', { name: 'Copy full ID v31-434' });
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toContain('1000098765434'));
    expect(screen.getByText('Could not copy — the full ID is shown instead.')).toBeTruthy();
  });
});

describe('filtering', () => {
  it('keeps only free agents and drops accounts that have none', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    await user.click(screen.getByRole('button', { name: /^Free/ }));
    // v12 has no agents at all, which is as free as it gets; v3 is fully busy.
    expect(groupNames()).toEqual(['v12', 'v31']);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.getAttribute('data-free')).toBe('true');
  });

  it('keeps only running agents the other way round', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    await user.click(screen.getByRole('button', { name: /^Running/ }));
    expect(groupNames()).toEqual(['v3', 'v31']);
    expect(rows().every(row => row.getAttribute('data-free') === 'false')).toBe(true);
  });

  it('searches by name, id and run, and names an empty result', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    const search = screen.getByRole('searchbox', { name: 'Search accounts' });
    await user.type(search, 'slim');
    expect(groupNames()).toEqual(['v3']);
    // The chips count what the search left, not the whole space.
    expect(screen.getByRole('button', { name: /^All/ }).textContent).toBe('All1');
    expect(screen.getByRole('button', { name: /^Running/ }).textContent).toBe('Running1');
    await user.clear(search);
    await user.type(search, '765401');
    expect(rows()).toHaveLength(1);
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('Nothing found for “zzz”.')).toBeTruthy();
  });
});

describe('writing a run', () => {
  it('adds a run from the plus and saves on Enter', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const freeRow = rows().find(row => row.getAttribute('data-free') === 'true')!;
    await user.click(within(freeRow).getByRole('button', { name: 'Add a run to v31-401' }));

    const field = screen.getByRole('textbox', { name: /^Run,/ });
    expect(document.activeElement).toBe(field);
    // The id is not editable on this path: the quick path is the run alone.
    expect(screen.queryByRole('textbox', { name: 'Full agent ID' })).toBeNull();
    await user.type(field, 'Keto | PL 05/09{Enter}');

    await waitFor(() =>
      expect(api.addAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          agentRowId: freeRow.getAttribute('data-agent-row-id'),
          note: 'Keto | PL 05/09'
        })
      )
    );
    await waitFor(() => expect(screen.getByText('Keto | PL 05/09')).toBeTruthy());
    expect(rows().every(row => row.getAttribute('data-free') === 'false')).toBe(true);
    // Focus comes back to the plus that opened the field, not to the page.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Add a run to v31-401')
    );
  });

  it('keeps several runs on one agent, edits one and deletes one with undo', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const busyRow = rows().find(row => row.textContent?.includes('Pro Caps'))!;
    await user.click(within(busyRow).getByRole('button', { name: 'Add a run to v31-434' }));
    await user.type(screen.getByRole('textbox', { name: /^Run,/ }), 'Keto | PL 06/09{Enter}');
    await waitFor(() => expect(within(busyRow).getByText('Keto | PL 06/09')).toBeTruthy());
    expect(within(busyRow).getByText('Pro Caps | TR 02/09')).toBeTruthy();

    await user.click(
      within(busyRow).getByRole('button', { name: 'Edit the run: Pro Caps | TR 02/09' })
    );
    const field = screen.getByRole('textbox', { name: /^Run,/ });
    await user.clear(field);
    await user.type(field, 'Pro Caps | TR 03/09{Enter}');
    await waitFor(() =>
      expect(api.updateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({ note: 'Pro Caps | TR 03/09' })
      )
    );

    await user.click(
      within(busyRow).getByRole('button', { name: 'Delete the run: Keto | PL 06/09' })
    );
    await waitFor(() => expect(api.deleteAgentRun).toHaveBeenCalled());
    expect(within(busyRow).queryByText('Keto | PL 06/09')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(within(busyRow).getByText('Keto | PL 06/09')).toBeTruthy());
  });

  it('frees a running agent with one press', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const busyRow = rows().find(row => row.textContent?.includes('Pro Caps'))!;
    await user.click(within(busyRow).getByRole('button', { name: /^Mark free/ }));
    await waitFor(() =>
      expect(api.clearAgentRuns).toHaveBeenCalledWith(
        expect.objectContaining({ agentRowId: busyRow.getAttribute('data-agent-row-id') })
      )
    );
    await waitFor(() => expect(screen.getByText('v31-434 is free')).toBeTruthy());
    expect(busyRow.getAttribute('data-free')).toBe('true');
  });

  it('offers to undo a release, and puts the runs back', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const busyRow = rows().find(row => row.textContent?.includes('Pro Caps'))!;
    await user.click(within(busyRow).getByRole('button', { name: /^Mark free/ }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(api.addAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({ note: 'Pro Caps | TR 02/09' })
      )
    );
    await waitFor(() => expect(within(busyRow).getByText('Pro Caps | TR 02/09')).toBeTruthy());
  });

  it('refuses to open a second editor over unsaved typing, and says so', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const freeRow = rows().find(row => row.getAttribute('data-free') === 'true')!;
    await user.click(within(freeRow).getByRole('button', { name: 'Add a run to v31-401' }));
    await user.type(screen.getByRole('textbox', { name: /^Run,/ }), 'half a thou');
    const busyRow = rows().find(row => row.textContent?.includes('Slim Fit'))!;
    await user.click(within(busyRow).getByRole('button', { name: /^Edit agent/ }));
    // Still one editor, still holding the typing, now with the reason.
    expect(screen.getAllByRole('textbox', { name: /^Run,/ })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: /^Run,/ }) as HTMLInputElement).value).toBe(
      'half a thou'
    );
    expect(screen.getByRole('status').textContent).toContain('Finish this one first');
    // Letting go (Escape in the field, or its cancel mark) frees the way.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(busyRow).getByRole('button', { name: /^Edit agent/ }));
    expect(screen.getByRole('textbox', { name: 'Full agent ID' })).toBeTruthy();
  });

  it('abandons the run field on Escape without saving', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const freeRow = rows().find(row => row.getAttribute('data-free') === 'true')!;
    await user.click(within(freeRow).getByRole('button', { name: 'Add a run to v31-401' }));
    await user.type(screen.getByRole('textbox', { name: /^Run,/ }), 'oops{Escape}');
    expect(screen.queryByRole('textbox', { name: /^Run,/ })).toBeNull();
    expect(api.addAgentRun).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Add a run to v31-401')
    );
  });
});

describe('accounts and agents', () => {
  it('names a new account and goes straight to its first agent', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    await user.click(screen.getByRole('button', { name: 'Add account' }));
    await user.type(screen.getByRole('textbox', { name: /^Account name/ }), 'v40{Enter}');
    await waitFor(() =>
      expect(api.createAccount).toHaveBeenCalledWith({ teamId: TEAM_ID, name: 'v40' })
    );
    // The agent editor is already open inside the new account.
    const idField = await screen.findByRole('textbox', { name: 'Full agent ID' });
    expect(document.activeElement).toBe(idField);
    await user.type(idField, '2000000000777{Enter}');
    await waitFor(() =>
      expect(api.addAccountAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: '2000000000777', note: null })
      )
    );
    const v40 = screen.getByRole('region', { name: 'v40' });
    expect(within(v40).getByText('v40-777')).toBeTruthy();
    // The editor stays open, emptied, for the next agent; the toast is the receipt.
    expect((screen.getByRole('textbox', { name: 'Full agent ID' }) as HTMLInputElement).value).toBe(
      ''
    );
    expect(screen.getByText('v40-777 added')).toBeTruthy();
  });

  it('keeps a freshly named account on screen while a filter would hide it', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    await user.click(screen.getByRole('button', { name: /^Running/ }));
    await user.click(screen.getByRole('button', { name: 'Add account' }));
    await user.type(screen.getByRole('textbox', { name: /^Account name/ }), 'v40{Enter}');
    // No agents yet, so the filter alone would drop it — but its editor is open.
    expect(await screen.findByRole('textbox', { name: 'Full agent ID' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'v40' })).toBeTruthy();
  });

  it('explains a duplicate name in the row rather than losing the typing', async () => {
    const api = client();
    api.createAccount = vi.fn().mockRejectedValue(
      Object.assign(new Error('NAME_CONFLICT'), {
        code: 'NAME_CONFLICT'
      })
    );
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    await user.click(screen.getByRole('button', { name: 'Add account' }));
    await user.type(screen.getByRole('textbox', { name: /^Account name/ }), 'v31{Enter}');
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This space already has that account.'
    );
    expect((screen.getByRole('textbox', { name: /^Account name/ }) as HTMLInputElement).value).toBe(
      'v31'
    );
  });

  it('refuses an id with a space before asking the server', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const v12 = screen.getByRole('region', { name: 'v12' });
    await user.click(within(v12).getByRole('button', { name: 'Add agent' }));
    await user.type(screen.getByRole('textbox', { name: 'Full agent ID' }), '10 00{Enter}');
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'An ID is 1–64 characters without spaces.'
    );
    expect(api.addAccountAgent).not.toHaveBeenCalled();
  });

  it('asks before deleting an account and names what goes with it', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const v31 = screen.getByRole('region', { name: 'v31' });
    await user.click(within(v31).getByRole('button', { name: 'Delete account: v31' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete v31?')).toBeTruthy();
    expect(within(dialog).getByText('Its 2 agents and their runs go with it.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(api.deleteAccount).toHaveBeenCalledWith({ teamId: TEAM_ID, accountId: V31 })
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: 'v31' })).toBeNull());
    // The section's buttons are gone; focus lands on the one that is always there.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Add account'));
  });

  it('starts a delete dialog on Cancel, so a second Enter does not delete', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const v31 = screen.getByRole('region', { name: 'v31' });
    await user.click(within(v31).getByRole('button', { name: 'Delete account: v31' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    );
  });

  it('folds an account and remembers the fold', async () => {
    const api = client();
    const user = userEvent.setup();
    const first = render(api);
    await waitForGroups();
    await user.click(screen.getByRole('button', { name: 'Collapse v31' }));
    expect(within(screen.getByRole('region', { name: 'v31' })).queryByText('v31-434')).toBeNull();
    first.unmount();

    render(api);
    await waitForGroups();
    expect(screen.getByRole('button', { name: 'Expand v31' })).toBeTruthy();
  });
});

describe('a viewer', () => {
  it('sees the list but none of the controls', async () => {
    render(client(), 'viewer');
    await waitForGroups();
    expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add a run to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Mark free/ })).toBeNull();
    // Copying stays: a viewer still needs the id.
    expect(screen.getAllByRole('button', { name: /^Copy full ID/ })).toHaveLength(3);
  });
});
