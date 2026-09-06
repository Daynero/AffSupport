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
import { act, renderHook } from '@testing-library/react';
import { useAccounts } from '../apps/web/src/team/accounts/useAccounts';
import { DEFAULT_ROLE_PERMISSIONS, type TeamAccountSummary } from '@video-compressor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { AccountSpace, type AccountSpaceClient } from '../apps/web/src/team/accounts';
import { runAgeLabel } from '../apps/web/src/team/accounts/AgentRow';

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
function agent(accountId: string, agentId: string, note: string | null, taskCount = 0) {
  sequence += 1;
  const id = `${accountId.slice(0, -4)}a${String(sequence).padStart(3, '0')}`;
  return {
    id,
    accountId,
    teamId: TEAM_ID,
    agentId,
    runs: note === null ? [] : [{ id: `${id}-run1`, note, marker: null, createdAt: STAMP }],
    labels: [],
    balance: null,
    topup: null,
    taskCount,
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
        agent(V31, '1000098765434', 'Pro Caps | TR 02/09', 2),
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
    // 019 — the money on an agent, its tags, and the space's dictionary.
    setAgentMoney: vi.fn(async ({ agentRowId, balance, topup }) => {
      const existing = accounts.flatMap(item => item.agents).find(item => item.id === agentRowId)!;
      existing.balance = balance;
      existing.topup = topup;
      return { ...existing };
    }),
    clearAgentBalances: vi.fn(async () => {
      const cleared = accounts
        .flatMap(item => item.agents)
        .filter(item => item.balance !== null)
        .map(item => ({ agentRowId: item.id, balance: item.balance! }));
      for (const item of accounts.flatMap(account => account.agents)) item.balance = null;
      return cleared;
    }),
    clearAgentTopups: vi.fn(async () => {
      const cleared = accounts
        .flatMap(item => item.agents)
        .filter(item => item.topup !== null)
        .map(item => ({ agentRowId: item.id, topup: item.topup! }));
      for (const item of accounts.flatMap(account => account.agents)) item.topup = null;
      return cleared;
    }),
    attachAgentLabel: vi.fn(async ({ agentRowId, labelId }) => {
      const existing = accounts.flatMap(item => item.agents).find(item => item.id === agentRowId)!;
      if (!existing.labels.some(label => label.id === labelId)) {
        existing.labels = [...existing.labels, { id: labelId, name: labelId, color: 'purple' }];
      }
      return { ...existing };
    }),
    detachAgentLabel: vi.fn(async ({ agentRowId, labelId }) => {
      const existing = accounts.flatMap(item => item.agents).find(item => item.id === agentRowId)!;
      existing.labels = existing.labels.filter(label => label.id !== labelId);
      return { ...existing };
    }),
    listTaskLabels: vi.fn().mockResolvedValue([]),
    createTaskLabel: vi.fn(),
    updateTaskLabel: vi.fn(),
    deleteTaskLabel: vi.fn().mockResolvedValue(true),
    // Runs live in the closure, so add / edit / delete / clear round-trip.
    addAgentRun: vi.fn(async ({ agentRowId, note }) => {
      const existing = accounts.flatMap(item => item.agents).find(item => item.id === agentRowId)!;
      existing.runs = [
        ...existing.runs,
        { id: `${agentRowId}-run${existing.runs.length + 1}`, note, marker: null, createdAt: STAMP }
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
    }),
    clearAgentRunMarkers: vi.fn(async () => {
      const cleared: { runId: string; marker: 'green' | 'amber' | 'red' }[] = [];
      for (const item of accounts.flatMap(account => account.agents)) {
        item.runs = item.runs.map(run => {
          if (run.marker === null) return run;
          cleared.push({ runId: run.id, marker: run.marker });
          return { ...run, marker: null };
        });
      }
      return cleared;
    }),
    setAgentRunMarker: vi.fn(async ({ runId, marker }) => {
      const existing = accounts
        .flatMap(item => item.agents)
        .find(item => item.runs.some(run => run.id === runId))!;
      existing.runs = existing.runs.map(run => (run.id === runId ? { ...run, marker } : run));
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

/** The agent's own actions sit behind the row's "…"; this opens it. */
async function openAgentMenu(user: ReturnType<typeof userEvent.setup>, row: HTMLElement) {
  await user.click(within(row).getByRole('button', { name: /^More actions for/ }));
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
    // Free first: the question the tab is opened with is where to start.
    expect(agentRows[0]?.getAttribute('data-free')).toBe('true');
    expect(agentRows[1]?.getAttribute('data-free')).toBe('false');
    // The tail only; the whole id is in the title of the copy button.
    // The tag, never the bare tail: an agent must not read like a second account.
    expect(agentRows[1]?.textContent).toContain('v31-434');
    expect(agentRows[1]?.textContent).not.toContain('1000098765434');
    // The tooltip carries the full id.
    expect(
      within(agentRows[1]!)
        .getByRole('button', { name: /^Copy full ID v31-434/ })
        .getAttribute('title')
    ).toContain('1000098765434');
    // The state is a word of its own, not only a colour.
    expect(within(agentRows[0]!).getByText('Free')).toBeTruthy();
    expect(within(agentRows[1]!).getByText('Running')).toBeTruthy();
  });

  it('counts agents on the filter chips', async () => {
    render(client());
    await waitForGroups();
    expect(chip('Show agents', /^All/).textContent).toBe('All3');
    expect(chip('Show agents', /^Free/).textContent).toBe('Free1');
    expect(chip('Show agents', /^Running/).textContent).toBe('Running2');
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
    const button = screen.getByRole('button', { name: /^Copy full ID v31-434/ });
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
    const button = screen.getByRole('button', { name: /^Copy full ID v31-434/ });
    const row = rows().find(item => item.contains(button))!;
    fireEvent.click(button);
    // The id is text beside the copy now, so the row is where it shows up.
    await waitFor(() => expect(row.textContent).toContain('1000098765434'));
    expect(screen.getByText('Could not copy — the full ID is shown instead.')).toBeTruthy();
  });
});

/** The occupancy chips share their names with the marker menu; this says which. */
function chip(group: 'Show agents', name: RegExp) {
  return within(screen.getByRole('group', { name: group })).getByRole('button', { name });
}

/** The marker filter is a menu behind one trigger; this opens it. */
async function openMarkers(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Markers/ }));
  return within(screen.getByRole('dialog', { name: 'Filter agents by run marker' }));
}

describe('filtering', () => {
  it('keeps only free agents and drops accounts that have none', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    await user.click(chip('Show agents', /^Free/));
    // v12 has no agents at all, which is as free as it gets; v3 is fully busy.
    expect(groupNames()).toEqual(['v12', 'v31']);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.getAttribute('data-free')).toBe('true');
  });

  it('keeps only running agents the other way round', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    await user.click(chip('Show agents', /^Running/));
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
    expect(chip('Show agents', /^All/).textContent).toBe('All1');
    expect(chip('Show agents', /^Running/).textContent).toBe('Running1');
    await user.clear(search);
    await user.type(search, '765401');
    expect(rows()).toHaveLength(1);
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('Nothing found for “zzz”.')).toBeTruthy();
  });
});

describe('marking a run', () => {
  const markButton = () => screen.getByRole('button', { name: /^Mark the run: Pro Caps/ });

  it('cycles green, amber, red and back to none on four presses', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    for (const marker of ['green', 'amber', 'red', null]) {
      await user.click(markButton());
      await waitFor(() =>
        expect(api.setAgentRunMarker).toHaveBeenLastCalledWith(expect.objectContaining({ marker }))
      );
    }
    expect(api.setAgentRunMarker).toHaveBeenCalledTimes(4);
  });

  it('paints the run and counts it in the marker menu', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    expect((await openMarkers(user)).getByRole('button', { name: /^Green/ }).textContent).toBe(
      'Green0'
    );
    await user.keyboard('{Escape}');
    await user.click(markButton());
    await waitFor(() =>
      expect(document.querySelector('.team-agent-run[data-marker="green"]')).toBeTruthy()
    );
    expect((await openMarkers(user)).getByRole('button', { name: /^Green/ }).textContent).toBe(
      'Green1'
    );
  });

  it('keeps only the agents carrying that colour when a colour is chosen', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    await user.click(markButton());
    await waitFor(() =>
      expect(document.querySelector('.team-agent-run[data-marker="green"]')).toBeTruthy()
    );
    await user.click((await openMarkers(user)).getByRole('button', { name: /^Green/ }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('Pro Caps');
    // And back: "All" is the whole list again.
    await user.click((await openMarkers(user)).getByRole('button', { name: /^All/ }));
    expect(rows().length).toBeGreaterThan(1);
  });

  it('clears every marker in the space from the menu, and offers to put them back', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    await user.click(markButton());
    await waitFor(() =>
      expect(document.querySelector('.team-agent-run[data-marker="green"]')).toBeTruthy()
    );
    await user.click((await openMarkers(user)).getByRole('button', { name: 'Clear all markers' }));
    await waitFor(() =>
      expect(document.querySelector('.team-agent-run[data-marker="green"]')).toBeNull()
    );
    expect(await screen.findByText('Markers cleared: 1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(api.setAgentRunMarker).toHaveBeenLastCalledWith(
        expect.objectContaining({ marker: 'green' })
      )
    );
    await waitFor(() =>
      expect(document.querySelector('.team-agent-run[data-marker="green"]')).toBeTruthy()
    );
  });

  it('has nothing to clear until something is marked', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    const menu = await openMarkers(user);
    expect(menu.getByRole('button', { name: 'Clear all markers' }).hasAttribute('disabled')).toBe(
      true
    );
  });

  it('gives a viewer no marker to press and nothing to clear', async () => {
    const user = userEvent.setup();
    render(client(), 'viewer');
    await waitForGroups();
    expect(screen.queryByRole('button', { name: /^Mark the run/ })).toBeNull();
    const menu = await openMarkers(user);
    expect(menu.queryByRole('button', { name: 'Clear all markers' })).toBeNull();
  });
});

describe('writing a run', () => {
  it('adds a run from the plus and saves on Enter', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const freeRow = rows().find(row => row.getAttribute('data-free') === 'true')!;
    await user.click(within(freeRow).getByRole('button', { name: 'Assign a run to v31-401' }));

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
    // Focus comes back to the button that opened the field, not to the page —
    // which now says "Add a run", the agent no longer being free.
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
    await user.click(within(busyRow).getByRole('button', { name: /^Make free/ }));
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
    await user.click(within(busyRow).getByRole('button', { name: /^Make free/ }));
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
    await user.click(within(freeRow).getByRole('button', { name: 'Assign a run to v31-401' }));
    await user.type(screen.getByRole('textbox', { name: /^Run,/ }), 'half a thou');
    const busyRow = rows().find(row => row.textContent?.includes('Slim Fit'))!;
    await openAgentMenu(user, busyRow);
    await user.click(screen.getByRole('menuitem', { name: /^Edit agent/ }));
    // Still one editor, still holding the typing, now with the reason.
    expect(screen.getAllByRole('textbox', { name: /^Run,/ })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: /^Run,/ }) as HTMLInputElement).value).toBe(
      'half a thou'
    );
    expect(screen.getByRole('status').textContent).toContain('Finish this one first');
    // Letting go (Escape in the field, or its cancel mark) frees the way.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await openAgentMenu(user, busyRow);
    await user.click(screen.getByRole('menuitem', { name: /^Edit agent/ }));
    expect(screen.getByRole('textbox', { name: 'Full agent ID' })).toBeTruthy();
  });

  it('abandons the run field on Escape without saving', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const freeRow = rows().find(row => row.getAttribute('data-free') === 'true')!;
    await user.click(within(freeRow).getByRole('button', { name: 'Assign a run to v31-401' }));
    await user.type(screen.getByRole('textbox', { name: /^Run,/ }), 'oops{Escape}');
    expect(screen.queryByRole('textbox', { name: /^Run,/ })).toBeNull();
    expect(api.addAgentRun).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Assign a run to v31-401')
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

describe('when a run was written', () => {
  const day = (offset: number) => {
    const at = new Date();
    at.setDate(at.getDate() + offset);
    at.setHours(12, 0, 0, 0);
    return at.toISOString();
  };

  it('says nothing for today, because nearly every line would say it', () => {
    expect(runAgeLabel(day(0), 'en')).toBeNull();
  });

  it('names the day inside the week and dates what is older', () => {
    expect(runAgeLabel(day(-1), 'en')).toBe('yesterday');
    expect(runAgeLabel(day(-3), 'en')).toBe('3 days ago');
    expect(runAgeLabel(day(-30), 'en')).toMatch(/^\d{2}\/\d{2}$/);
  });

  it('says nothing for a stamp it cannot use', () => {
    expect(runAgeLabel(day(2), 'en')).toBeNull();
    expect(runAgeLabel('not a date', 'en')).toBeNull();
  });
});

describe('the row menu', () => {
  it('opens onto its first item, walks with the arrows and closes on Escape', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    const row = rows().find(item => item.textContent?.includes('Pro Caps'))!;
    const trigger = within(row).getByRole('button', { name: /^More actions for/ });

    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const edit = screen.getByRole('menuitem', { name: /^Edit agent/ });
    const remove = screen.getByRole('menuitem', { name: /^Delete agent/ });
    expect(document.activeElement).toBe(edit);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(remove);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(edit);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(remove);

    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The focus goes back to the "…" that opened it, not to the page.
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps one menu open across the whole list, and closes on a press outside', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    const [first, second] = rows();
    await user.click(within(first!).getByRole('button', { name: /^More actions for/ }));
    await user.click(within(second!).getByRole('button', { name: /^More actions for/ }));
    // Two triggers, one menu: the first one gave way rather than staying open
    // behind the second with both claiming to be expanded.
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(
      screen
        .getAllByRole('button', { name: /^More actions for/ })
        .filter(button => button.getAttribute('aria-expanded') === 'true')
    ).toHaveLength(1);

    await user.click(screen.getByRole('searchbox', { name: 'Search accounts' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hands focus back to the "…" after the delete dialog is dismissed', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    const row = rows().find(item => item.textContent?.includes('Pro Caps'))!;
    const trigger = within(row).getByRole('button', { name: /^More actions for/ });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: /^Delete agent/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('deleting an agent', () => {
  it('removes it and leaves the focus somewhere in the account it was in', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const row = rows().find(item => item.textContent?.includes('Pro Caps'))!;
    const rowId = row.getAttribute('data-agent-row-id');
    await user.click(within(row).getByRole('button', { name: /^More actions for/ }));
    await user.click(screen.getByRole('menuitem', { name: /^Delete agent/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete v31-434?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete agent' }));

    await waitFor(() =>
      expect(api.deleteAccountAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentRowId: rowId })
      )
    );
    await waitFor(() => expect(screen.getByText('Agent deleted')).toBeTruthy());
    // The row and its dialog went together, so the focus must be handed on
    // rather than left on the body with the whole list to tab through again.
    await waitFor(() => {
      const active = document.activeElement;
      expect(active).not.toBe(document.body);
      expect(screen.getByRole('region', { name: 'v31' }).contains(active)).toBe(true);
    });
  });
});

describe('how many tasks name an agent', () => {
  it('is a link on the line of the run, and nothing at all when there are none', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    const busy = rows().find(item => item.textContent?.includes('Pro Caps'))!;
    const link = within(busy).getByRole('link', { name: '2 tasks' });
    // On the line of the run it is read with, not in a column of its own.
    expect(link.closest('.team-agent-run')).not.toBeNull();

    // An agent no task names says nothing. It used to say "—", and the owner
    // read that dash as a delete mark and pressed it.
    const free = rows().find(row => row.getAttribute('data-free') === 'true')!;
    expect(within(free).queryByRole('link', { name: /task/ })).toBeNull();
    expect(free.textContent).not.toContain('—');

    await user.click(screen.getByRole('button', { name: /^Free/ }));
    expect(screen.queryAllByRole('link', { name: '2 tasks' })).toHaveLength(0);
  });
});

describe('an editor a filter would close over', () => {
  it('keeps the row being written, and not the neighbours the filter hides', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    const search = screen.getByRole('searchbox', { name: 'Search accounts' });
    await user.type(search, '434');

    const row = rows().find(item => item.textContent?.includes('v31-434'))!;
    await user.click(within(row).getByRole('button', { name: /^More actions for/ }));
    await user.click(screen.getByRole('menuitem', { name: /^Edit agent/ }));
    expect(screen.getByRole('textbox', { name: 'Full agent ID' })).toBeTruthy();

    // Narrowing the search under an open editor drops the account it is in.
    // It is held back on screen — but only with the row under the caret, in
    // the list's own order, not with every agent the account happens to own.
    await user.clear(search);
    await user.type(search, 'zzz');
    const v31 = screen.getByRole('region', { name: 'v31' });
    expect(within(v31).getByRole('textbox', { name: 'Full agent ID' })).toBeTruthy();
    expect(v31.textContent).not.toContain('v31-401');
  });
});

describe('searching', () => {
  it('marks what answered the search and counts what it left', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    await user.type(screen.getByRole('searchbox', { name: 'Search accounts' }), 'pro caps');

    const row = rows().find(item => item.textContent?.includes('Pro Caps'))!;
    expect(within(row).getByText('Pro Caps', { selector: 'mark' })).toBeTruthy();
    // And in a name, not only in a run: "v31" typed marks the account's head.
    await user.clear(screen.getByRole('searchbox', { name: 'Search accounts' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search accounts' }), 'v31');
    const v31 = screen.getByRole('region', { name: 'v31' });
    expect(within(v31).getAllByText('v31', { selector: 'mark' }).length).toBeGreaterThan(0);
    await user.clear(screen.getByRole('searchbox', { name: 'Search accounts' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search accounts' }), 'pro caps');
    // The page's own totals do not quietly become the matches.
    expect(screen.getByText('1 of 3 accounts')).toBeTruthy();
    expect(screen.getByText('1 of 3 agents')).toBeTruthy();
  });

  it('says how many agents of an account are on screen', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    await user.type(screen.getByRole('searchbox', { name: 'Search accounts' }), '765434');
    const v31 = screen.getByRole('region', { name: 'v31' });
    expect(within(v31).getByText('1 of 2 agents')).toBeTruthy();
  });
});

describe('folding an account', () => {
  it('folds from anywhere on its head, and not from the buttons on it', async () => {
    const api = client();
    const user = userEvent.setup();
    render(api);
    await waitForGroups();
    const v31 = screen.getByRole('region', { name: 'v31' });
    const head = v31.querySelector('.team-account-head') as HTMLElement;

    // The name, not the chevron: pressing the account is what a hand does.
    await user.click(within(v31).getByRole('heading', { name: 'v31' }));
    expect(within(v31).queryByText('v31-434')).toBeNull();
    await user.click(head);
    expect(within(v31).getByText('v31-434')).toBeTruthy();

    // Its own buttons do their own work and leave the fold alone.
    await user.click(within(v31).getByRole('button', { name: 'Add agent' }));
    expect(await screen.findByRole('textbox', { name: 'Full agent ID' })).toBeTruthy();
    expect(within(v31).getByText('v31-434')).toBeTruthy();
  });
});

describe('the head of an account', () => {
  it('says how it stands whether it is open or folded', async () => {
    const user = userEvent.setup();
    render(client());
    await waitForGroups();
    const v31 = screen.getByRole('region', { name: 'v31' });
    expect(within(v31).getByText('1 free')).toBeTruthy();
    expect(within(v31).getByText('1 running')).toBeTruthy();

    // Folded, the summary is the only thing left — and it is still there.
    await user.click(within(v31).getByRole('button', { name: 'Collapse v31' }));
    expect(within(v31).getByText('1 free')).toBeTruthy();
    expect(within(v31).getByText('1 running')).toBeTruthy();
  });

  it('counts accounts and agents apart, above the chips that count agents', async () => {
    render(client());
    await waitForGroups();
    expect(screen.getByText('3 accounts')).toBeTruthy();
    expect(screen.getByText('3 agents')).toBeTruthy();
  });
});

describe('a viewer', () => {
  it('sees the list but none of the controls', async () => {
    render(client(), 'viewer');
    await waitForGroups();
    expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add a run to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Assign a run to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Make free/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^More actions for/ })).toBeNull();
    // Copying stays: a viewer still needs the id.
    expect(screen.getAllByRole('button', { name: /^Copy full ID/ })).toHaveLength(3);
  });
});

/**
 * The money on an agent and the two lists it feeds (019). The figures are
 * written on blur, the steppers move by fifty, and the copy buttons put a
 * whole column on the clipboard — which is the part nobody can check by eye.
 */
describe('the money on an agent', () => {
  /** Everything the clipboard was handed, in order. */
  function clipboard(): string[] {
    const written: string[] = [];
    // `defineProperty`, as the copy tests above do it: `navigator.clipboard`
    // is a getter, and userEvent installs a stub of its own over it.
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn(async (text: string) => {
          written.push(text);
        })
      },
      configurable: true
    });
    return written;
  }

  it('writes both figures together when a field is left', async () => {
    const user = userEvent.setup();
    const api = client();
    render(api);
    await waitForGroups();

    const field = screen.getByRole('textbox', { name: 'Left v31-434' });
    await user.type(field, '250');
    await user.tab();
    await waitFor(() =>
      expect(api.setAgentMoney).toHaveBeenCalledWith(
        expect.objectContaining({ balance: 250, topup: null })
      )
    );
  });

  it('steps the top-up by fifty, and back to nothing', async () => {
    const user = userEvent.setup();
    const api = client();
    render(api);
    await waitForGroups();

    await user.click(screen.getByRole('button', { name: 'Add 50 more to v31-434' }));
    await waitFor(() =>
      expect(api.setAgentMoney).toHaveBeenCalledWith(expect.objectContaining({ topup: 50 }))
    );
    await user.click(screen.getByRole('button', { name: 'Take 50 off v31-434' }));
    await waitFor(() =>
      expect(api.setAgentMoney).toHaveBeenLastCalledWith(expect.objectContaining({ topup: null }))
    );
  });

  it('copies the day’s top-ups, by account and by tag, and clears them with an undo', async () => {
    const accounts = fixture();
    accounts[0]!.agents[0]!.topup = 50;
    accounts[0]!.agents[0]!.labels = [{ id: 'l-2', name: '#2', color: 'purple' }];
    const api = client(accounts);
    render(api);
    await waitForGroups();
    const user = userEvent.setup();
    const written = clipboard();

    await user.click(screen.getByRole('button', { name: 'Copy with names' }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain('- $50');
    await user.click(screen.getByRole('button', { name: 'Copy with IDs' }));
    await waitFor(() => expect(written).toHaveLength(2));
    expect(written[1]).toContain('#2');

    await user.click(screen.getByRole('button', { name: 'Clear the top-ups' }));
    await waitFor(() => expect(api.clearAgentTopups).toHaveBeenCalled());
    // One press cleared them; one more press puts them back.
    const undo = await screen.findByRole('button', { name: 'Undo' });
    await user.click(undo);
    await waitFor(() =>
      expect(api.setAgentMoney).toHaveBeenCalledWith(expect.objectContaining({ topup: 50 }))
    );
  });

  it('says how many of an account’s agents carry each tag', async () => {
    const accounts = fixture();
    accounts[0]!.agents[0]!.labels = [{ id: 'l-2', name: '#2', color: 'purple' }];
    accounts[0]!.agents[1]!.labels = [
      { id: 'l-2', name: '#2', color: 'purple' },
      { id: 'l-5', name: '#5', color: 'teal' }
    ];
    render(client(accounts));
    await waitForGroups();

    // v31 is the account the labels went on; the list sorts naturally, so it
    // is not the first one on screen.
    const head = groups()
      .map(group => group.querySelector('.team-account-meta') as HTMLElement)
      .find(meta => meta.textContent?.includes('#2'))!;
    expect(within(head).getByTitle('2 agents tagged #2').textContent).toContain('#2');
    expect(within(head).getByTitle('2 agents tagged #2').textContent).toContain('2');
    expect(within(head).getByTitle('1 agents tagged #5').textContent).toContain('#5');
  });

  it('clears the balances on their own, and leaves the top-ups alone', async () => {
    const user = userEvent.setup();
    const accounts = fixture();
    accounts[0]!.agents[0]!.balance = 300;
    accounts[0]!.agents[0]!.topup = 50;
    const api = client(accounts);
    render(api);
    await waitForGroups();

    await user.click(screen.getByRole('button', { name: 'Clear what is left' }));
    await waitFor(() => expect(api.clearAgentBalances).toHaveBeenCalled());
    expect(api.clearAgentTopups).not.toHaveBeenCalled();
    const topupField = screen.getByRole('textbox', {
      name: 'Add v31-434'
    }) as HTMLInputElement;
    await waitFor(() => expect(topupField.value).toBe('50'));
    expect((screen.getByRole('textbox', { name: 'Left v31-434' }) as HTMLInputElement).value).toBe(
      ''
    );

    // And the figure it erased comes back with one press.
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(api.setAgentMoney).toHaveBeenCalledWith(
        expect.objectContaining({ balance: 300, topup: 50 })
      )
    );
  });

  it('shows a viewer the figures and no way to change them', async () => {
    const accounts = fixture();
    accounts[0]!.agents[0]!.balance = 300;
    render(client(accounts), 'viewer');
    await waitForGroups();

    const field = screen.getByRole('textbox', { name: 'Left v31-434' }) as HTMLInputElement;
    expect(field.value).toBe('300');
    expect(field.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Add 50 more to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear the top-ups' })).toBeNull();
  });
});

/**
 * A list read that started before a write must not put the old figure back.
 *
 * Every write also fires a realtime event, and the re-read it schedules can
 * overtake the write it was fired by. In the browser this showed as a figure
 * typed into the money cell reverting a second later, and correcting itself
 * only on the next change — the kind of thing that reads as "it did not
 * save" and is impossible to reproduce on purpose.
 */
describe('a stale list read', () => {
  it('does not undo a newer write', async () => {
    const accounts = fixture();
    const api = client(accounts);
    let settle: ((value: TeamAccountSummary[]) => void) | null = null;
    (api.listAccounts as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<TeamAccountSummary[]>(resolve => {
          settle = resolve;
        })
    );

    const view = renderHook(props => useAccounts(props), {
      initialProps: { teamId: TEAM_ID, revision: 0, client: api }
    });
    // The first read lands: the list is on screen.
    await act(async () => {
      settle!(structuredClone(accounts));
    });
    expect(view.result.current.accounts).toHaveLength(3);

    // A second read starts (a teammate's change, say) and does not land yet.
    view.rerender({ teamId: TEAM_ID, revision: 1, client: api });
    const stale = view.result.current.accounts[0]!.agents[0]!;
    // What that read will answer with: the rows as they are *now*, before the
    // write below. Snapshotted here, because the stub writes into the array.
    const answerFromBefore = structuredClone(accounts);

    // A figure is written while that read is in flight…
    await act(async () => {
      await view.result.current.setMoney(stale, 777, 150);
    });
    // …and the read finally answers with the row as it was before it.
    await act(async () => {
      settle!(answerFromBefore);
    });

    const agentNow = view.result.current.accounts
      .flatMap(account => account.agents)
      .find(item => item.id === stale.id)!;
    expect({ balance: agentNow.balance, topup: agentNow.topup }).toEqual({
      balance: 777,
      topup: 150
    });
  });
});
