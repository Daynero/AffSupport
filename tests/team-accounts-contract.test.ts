import { describe, expect, it } from 'vitest';
import {
  buildTeamAgentTopupListByAccount,
  buildTeamAgentTopupListByLabel,
  compareTeamTasksByDate,
  countTeamAccounts,
  countTeamAgentTopups,
  normalizeTeamAgentAmount,
  stepTeamAgentTopup,
  filterTeamAccounts,
  isTeamAgentFree,
  normalizeTeamAccountName,
  normalizeTeamAgentId,
  nextTeamAgentRunMarker,
  normalizeTeamAgentNote,
  parseTeamAccount,
  parseTeamAccountAgent,
  parseTeamTaskAgentTags,
  sortTeamAccounts,
  sortTeamAgents,
  teamTaskAgentTagLabel,
  teamAccountTag,
  teamAgentIdSuffix,
  teamAgentLabel,
  teamTaskDate,
  type TeamAccountSummary
} from '@video-compressor/shared';

/**
 * The accounts contract (017): the normalizers every write goes through, the
 * parser every read goes through, and the two derived facts the list is built
 * on — free/busy and the `[name-suffix]` tag a task will carry.
 */

const TEAM = '17000000-0000-4000-8000-000000000001';

function agent(
  accountId: string,
  agentId: string,
  note: string | null,
  index: number
): TeamAccountSummary['agents'][number] {
  const id = `${accountId.slice(0, -2)}${String(index).padStart(2, '0')}`;
  return {
    id,
    accountId,
    teamId: TEAM,
    agentId,
    runs:
      note === null
        ? []
        : [{ id: `${id}-run`, note, marker: null, createdAt: '2026-09-05T10:00:00.000Z' }],
    labels: [],
    balance: null,
    topup: null,
    taskCount: 0,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z'
  };
}

function account(id: string, name: string, agents: [string, string | null][]): TeamAccountSummary {
  return {
    id,
    teamId: TEAM,
    name,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    agents: agents.map(([agentId, note], index) => agent(id, agentId, note, index))
  };
}

const V3 = '17000000-0000-4000-8000-000000000300';
const V12 = '17000000-0000-4000-8000-000000001200';
const V31 = '17000000-0000-4000-8000-000000003100';

const SPACE: TeamAccountSummary[] = [
  account(V31, 'v31', [
    ['1000098765434', 'Pro Caps | TR 02/09'],
    ['1000098765401', null]
  ]),
  account(V3, 'v3', [
    ['1000011122211', 'Slim Fit | DE 01/09'],
    ['1000011122252', null]
  ]),
  account(V12, 'v12', [['2000000000901', 'Keto | PL 03/09']])
];

describe('normalizers', () => {
  it('accepts a name with its whitespace collapsed and refuses brackets', () => {
    expect(normalizeTeamAccountName('  v31 ')).toBe('v31');
    expect(normalizeTeamAccountName('Main   BM')).toBe('Main BM');
    // Brackets would break the tag's own delimiters.
    expect(normalizeTeamAccountName('[v31]')).toBeNull();
    expect(normalizeTeamAccountName('')).toBeNull();
    expect(normalizeTeamAccountName('x'.repeat(41))).toBeNull();
    expect(normalizeTeamAccountName(31)).toBeNull();
  });

  it('accepts an id as a single token only', () => {
    expect(normalizeTeamAgentId(' 1000098765434 ')).toBe('1000098765434');
    expect(normalizeTeamAgentId('act_abc-123')).toBe('act_abc-123');
    // Two things pasted, not one.
    expect(normalizeTeamAgentId('1000 0987')).toBeNull();
    expect(normalizeTeamAgentId('')).toBeNull();
    expect(normalizeTeamAgentId('9'.repeat(65))).toBeNull();
  });

  it('treats a blank note as no note, and refuses one that is too long', () => {
    expect(normalizeTeamAgentNote(null)).toBeNull();
    expect(normalizeTeamAgentNote('   ')).toBeNull();
    expect(normalizeTeamAgentNote(' Pro Caps  |  TR 02/09 ')).toBe('Pro Caps | TR 02/09');
    expect(normalizeTeamAgentNote('x'.repeat(121))).toBeUndefined();
    expect(normalizeTeamAgentNote(42)).toBeUndefined();
  });
});

describe('the visible tail and the tag', () => {
  it('shows the last three characters, or all of a shorter id', () => {
    expect(teamAgentIdSuffix('1000098765434')).toBe('434');
    expect(teamAgentIdSuffix('42')).toBe('42');
  });

  it('builds the label and the tag a task will carry from the name and the tail', () => {
    expect(teamAgentLabel('v31', '1000098765434')).toBe('v31-434');
    expect(teamAccountTag('v31', '1000098765434')).toBe('[v31-434]');
  });
});

describe('parsing what the server returns', () => {
  it('maps an agent row with its runs, dropping a blank one', () => {
    const parsed = parseTeamAccountAgent({
      id: 'a',
      account_id: 'b',
      team_id: TEAM,
      agent_id: '1000098765434',
      runs: [
        { id: 'r1', note: 'Pro Caps | TR 02/09', created_at: '2026-09-05T10:00:00.000Z' },
        { id: 'r2', note: '   ', created_at: '2026-09-05T10:00:00.000Z' }
      ],
      created_at: '2026-09-05T10:00:00.000Z',
      updated_at: '2026-09-05T10:00:00.000Z'
    });
    expect(parsed?.runs.map(run => run.note)).toEqual(['Pro Caps | TR 02/09']);
    expect(parsed && isTeamAgentFree(parsed)).toBe(false);
  });

  it('refuses an agent nested under the wrong account', () => {
    const row = {
      id: V31,
      team_id: TEAM,
      name: 'v31',
      created_at: '2026-09-05T10:00:00.000Z',
      updated_at: '2026-09-05T10:00:00.000Z',
      agents: [
        {
          id: 'a',
          account_id: V3,
          team_id: TEAM,
          agent_id: '1',
          runs: [],
          labels: [],
          balance: null,
          topup: null,
          created_at: '2026-09-05T10:00:00.000Z',
          updated_at: '2026-09-05T10:00:00.000Z'
        }
      ]
    };
    expect(parseTeamAccount(row)).toBeNull();
    expect(parseTeamAccount({ ...row, agents: null })).toMatchObject({ agents: [] });
    expect(parseTeamAccount({ ...row, agents: 'nope' })).toBeNull();
  });
});

describe('ordering, counting and filtering', () => {
  it('sorts accounts naturally, so v3 comes before v12 and v31', () => {
    expect(sortTeamAccounts(SPACE).map(item => item.name)).toEqual(['v3', 'v12', 'v31']);
  });

  it('counts agents by occupancy', () => {
    expect(countTeamAccounts(SPACE)).toEqual({
      accounts: 3,
      agents: 5,
      free: 2,
      busy: 3,
      markers: { green: 0, amber: 0, red: 0 }
    });
  });

  it('keeps only free agents and drops an account with none', () => {
    const free = filterTeamAccounts(SPACE, { occupancy: 'free', search: '' });
    expect(free.map(item => [item.name, item.agents.length])).toEqual([
      ['v31', 1],
      ['v3', 1]
    ]);
    expect(free.every(item => item.agents.every(agent => agent.runs.length === 0))).toBe(true);
  });

  it('keeps an account with no agents under "free" but not under "running"', () => {
    const withEmpty = [...SPACE, account('17000000-0000-4000-8000-000000009900', 'v99', [])];
    expect(
      filterTeamAccounts(withEmpty, { occupancy: 'free', search: '' }).map(item => item.name)
    ).toEqual(['v31', 'v3', 'v99']);
    expect(
      filterTeamAccounts(withEmpty, { occupancy: 'busy', search: '' }).map(item => item.name)
    ).toEqual(['v31', 'v3', 'v12']);
    // A search that does not name it still hides it: there is nothing inside to match.
    expect(
      filterTeamAccounts(withEmpty, { occupancy: 'free', search: 'v3' }).map(item => item.name)
    ).toEqual(['v31', 'v3']);
  });

  it('keeps only running agents the other way round', () => {
    const busy = filterTeamAccounts(SPACE, { occupancy: 'busy', search: '' });
    expect(busy.map(item => [item.name, item.agents.length])).toEqual([
      ['v31', 1],
      ['v3', 1],
      ['v12', 1]
    ]);
  });

  it('matches a search against the name, the full id and the run', () => {
    // The name matches whole: every agent stays.
    expect(filterTeamAccounts(SPACE, { occupancy: 'all', search: 'V31' })).toHaveLength(1);
    expect(filterTeamAccounts(SPACE, { occupancy: 'all', search: 'v31' })[0]?.agents).toHaveLength(
      2
    );
    // An id or a run matches one agent: only it stays.
    const byId = filterTeamAccounts(SPACE, { occupancy: 'all', search: '765401' });
    expect(byId).toHaveLength(1);
    expect(byId[0]?.agents.map(agent => agent.agentId)).toEqual(['1000098765401']);
    const byRun = filterTeamAccounts(SPACE, { occupancy: 'all', search: 'keto' });
    expect(byRun.map(item => item.name)).toEqual(['v12']);
    expect(filterTeamAccounts(SPACE, { occupancy: 'all', search: 'nothing' })).toEqual([]);
  });

  it('applies the search and the occupancy together', () => {
    const result = filterTeamAccounts(SPACE, { occupancy: 'free', search: 'v3' });
    // "v3" is a substring of "v31" too, so both names match; each keeps its one free agent.
    expect(result.map(item => [item.name, item.agents.length])).toEqual([
      ['v31', 1],
      ['v3', 1]
    ]);
  });
});

describe('tags on tasks (017, part 2)', () => {
  const raw = {
    id: 'link-1',
    agent_row_id: 'agent-1',
    account_id: V31,
    account_name: 'v31',
    agent_id: '1000098765434',
    runs: [{ id: 'r1', note: 'Pro Caps | TR 02/09', created_at: '2026-09-05T10:00:00.000Z' }]
  };

  it('parses the tag list a task row carries, and reads no list as none', () => {
    expect(parseTeamTaskAgentTags([raw])).toEqual([
      {
        id: 'link-1',
        agentRowId: 'agent-1',
        accountId: V31,
        accountName: 'v31',
        agentId: '1000098765434',
        runs: [
          {
            id: 'r1',
            note: 'Pro Caps | TR 02/09',
            marker: null,
            createdAt: '2026-09-05T10:00:00.000Z'
          }
        ]
      }
    ]);
    expect(parseTeamTaskAgentTags(null)).toEqual([]);
    expect(parseTeamTaskAgentTags(undefined)).toEqual([]);
    expect(parseTeamTaskAgentTags([{ ...raw, runs: null }])?.[0]?.runs).toEqual([]);
    expect(parseTeamTaskAgentTags([{ ...raw, agent_id: 7 }])).toBeNull();
    expect(parseTeamTaskAgentTags('nope')).toBeNull();
  });

  it('labels a tag exactly as the accounts list would', () => {
    const [tag] = parseTeamTaskAgentTags([raw]) ?? [];
    expect(tag && teamTaskAgentTagLabel(tag)).toBe('v31-434');
  });

  it('reads an agent row with and without its task count', () => {
    const base = {
      id: 'a',
      account_id: 'b',
      team_id: TEAM,
      agent_id: '1',
      runs: [],
      labels: [],
      balance: null,
      topup: null,
      created_at: '2026-09-05T10:00:00.000Z',
      updated_at: '2026-09-05T10:00:00.000Z'
    };
    expect(parseTeamAccountAgent(base)?.taskCount).toBe(0);
    expect(parseTeamAccountAgent({ ...base, task_count: 3 })?.taskCount).toBe(3);
    expect(parseTeamAccountAgent({ ...base, task_count: -1 })).toBeNull();
  });
});

/**
 * The date a task is for (017, part 4): one answer for the card, the editor
 * and the order of the list, so a board cannot show one date and sort by
 * another.
 */
describe('the date a task is for', () => {
  const at = (id: string, dateOn: string | null, createdAt: string) => ({ id, dateOn, createdAt });

  it('falls back to the day the task was made', () => {
    expect(teamTaskDate(at('a', '2026-09-18', '2026-09-05T10:00:00.000Z'))).toBe('2026-09-18');
    // Local, not UTC: the day a person sees on the card.
    const created = new Date(2026, 8, 5, 10, 0, 0);
    expect(teamTaskDate(at('a', null, created.toISOString()))).toBe('2026-09-05');
  });

  it('orders by that date, then by when the row was made', () => {
    const moved = at('a', '2026-09-18', '2026-09-05T10:00:00.000Z');
    const madeToday = at('b', null, new Date(2026, 8, 5, 12, 0, 0).toISOString());
    const madeEarlier = at('c', null, new Date(2026, 8, 5, 9, 0, 0).toISOString());
    expect([madeEarlier, madeToday, moved].sort(compareTeamTasksByDate).map(t => t.id)).toEqual([
      'a',
      'b',
      'c'
    ]);
  });
});

describe('marking a run', () => {
  /** The same space, with one run of each colour on the three busy agents. */
  const marked: TeamAccountSummary[] = SPACE.map((account, index) => ({
    ...account,
    agents: account.agents.map(agentRow =>
      agentRow.runs.length === 0
        ? agentRow
        : {
            ...agentRow,
            runs: agentRow.runs.map(runRow => ({
              ...runRow,
              marker: (['green', 'amber', 'red'] as const)[index]!
            }))
          }
    )
  }));

  it('cycles unmarked → green → amber → red → unmarked', () => {
    expect(nextTeamAgentRunMarker(null)).toBe('green');
    expect(nextTeamAgentRunMarker('green')).toBe('amber');
    expect(nextTeamAgentRunMarker('amber')).toBe('red');
    expect(nextTeamAgentRunMarker('red')).toBeNull();
  });

  it('reads a marker off the server and an unknown one as none', () => {
    const parsed = parseTeamAccountAgent({
      id: 'a',
      account_id: 'b',
      team_id: TEAM,
      agent_id: '1000098765434',
      runs: [
        { id: 'r1', note: 'Pro Caps', marker: 'amber', created_at: '2026-09-05T10:00:00.000Z' },
        { id: 'r2', note: 'Keto', marker: 'chartreuse', created_at: '2026-09-05T10:00:00.000Z' },
        { id: 'r3', note: 'Slim', created_at: '2026-09-05T10:00:00.000Z' }
      ],
      created_at: '2026-09-05T10:00:00.000Z',
      updated_at: '2026-09-05T10:00:00.000Z'
    });
    expect(parsed?.runs.map(item => item.marker)).toEqual(['amber', null, null]);
  });

  it('counts the agents each colour would leave on screen', () => {
    expect(countTeamAccounts(marked).markers).toEqual({ green: 1, amber: 1, red: 1 });
  });

  it('keeps only the agents carrying that colour, and drops the accounts without one', () => {
    const green = filterTeamAccounts(marked, { occupancy: 'all', search: '', marker: 'green' });
    expect(green.map(item => item.name)).toEqual(['v31']);
    expect(green[0]?.agents.map(item => item.agentId)).toEqual(['1000098765434']);
    // "all" is every agent again, free ones included.
    expect(
      filterTeamAccounts(marked, { occupancy: 'all', search: '', marker: 'all' })
    ).toHaveLength(3);
  });

  it('reads the colour with the other filters, not instead of them', () => {
    // A free agent carries no runs, so no colour can keep it.
    expect(
      filterTeamAccounts(marked, { occupancy: 'free', search: '', marker: 'green' })
    ).toHaveLength(0);
    expect(
      filterTeamAccounts(marked, { occupancy: 'all', search: 'keto', marker: 'red' }).map(
        item => item.name
      )
    ).toEqual(['v12']);
    expect(
      filterTeamAccounts(marked, { occupancy: 'all', search: 'keto', marker: 'green' })
    ).toHaveLength(0);
  });
});

describe('the order agents are read in', () => {
  const run = (note: string) => ({
    id: `run-${note}`,
    note,
    marker: null,
    createdAt: '2026-09-05T10:00:00.000Z'
  });
  const agent = (
    agentId: string,
    runs: { id: string; note: string; marker: null; createdAt: string }[]
  ) => ({
    id: `row-${agentId}`,
    accountId: 'a1',
    teamId: 't1',
    agentId,
    runs,
    labels: [],
    balance: null,
    topup: null,
    taskCount: 0,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z'
  });

  it('puts the free ones first and orders the rest naturally', () => {
    const sorted = sortTeamAgents([
      agent('1000000000434', [run('Pro Caps')]),
      agent('1000000000401', []),
      agent('1000000000099', [run('Keto')]),
      agent('1000000000900', [])
    ]);
    expect(sorted.map(item => item.agentId)).toEqual([
      '1000000000401',
      '1000000000900',
      '1000000000099',
      '1000000000434'
    ]);
  });

  it('is stable enough that two reads of the same account agree', () => {
    const agents = [
      agent('1000000000434', [run('Pro Caps')]),
      agent('1000000000401', []),
      agent('1000000000900', [])
    ];
    expect(sortTeamAgents(agents).map(item => item.agentId)).toEqual(
      sortTeamAgents([...agents].reverse()).map(item => item.agentId)
    );
  });

  it('leaves the account it was given alone', () => {
    const agents = [agent('1000000000434', [run('Pro Caps')]), agent('1000000000401', [])];
    sortTeamAgents(agents);
    expect(agents.map(item => item.agentId)).toEqual(['1000000000434', '1000000000401']);
  });
});

/**
 * The two lists the accounts table copies out (019). They are the whole point
 * of the money fields, and the only part of the feature nobody can check by
 * eye — a list that quietly drops a row costs somebody a top-up.
 */
describe('the copied top-up lists', () => {
  const label = (id: string, name: string) => ({ id, name, color: 'purple' as const });

  function agentWith(
    accountId: string,
    agentId: string,
    topup: number | null,
    labels: { id: string; name: string; color: 'purple' }[] = []
  ) {
    return {
      id: `row-${agentId}`,
      accountId,
      teamId: '19000000-0000-4000-8000-000000000000',
      agentId,
      runs: [],
      labels,
      balance: 100,
      topup,
      taskCount: 0,
      createdAt: '2026-09-06T10:00:00.000Z',
      updatedAt: '2026-09-06T10:00:00.000Z'
    };
  }

  function space() {
    const hot = label('l-2', '#2');
    const cold = label('l-5', '#5');
    return [
      {
        id: 'acc-v31',
        teamId: '19000000-0000-4000-8000-000000000000',
        name: 'v31',
        createdAt: '2026-09-06T10:00:00.000Z',
        updatedAt: '2026-09-06T10:00:00.000Z',
        agents: [
          agentWith('acc-v31', '1000000000434', 50, [hot]),
          agentWith('acc-v31', '1000000000401', null, [hot]),
          agentWith('acc-v31', '1000000000455', 150, [hot, cold])
        ]
      },
      {
        id: 'acc-f40',
        teamId: '19000000-0000-4000-8000-000000000000',
        name: 'f40',
        createdAt: '2026-09-06T10:00:00.000Z',
        updatedAt: '2026-09-06T10:00:00.000Z',
        agents: [agentWith('acc-f40', '1000000000117', 100, [])]
      }
    ];
  }

  it('groups by social account, carries the full ids, and leaves out what has nothing to add', () => {
    expect(buildTeamAgentTopupListByAccount(space())).toBe(
      [
        'f40',
        '1000000000117 - $100',
        '',
        'v31',
        '1000000000434 - $50',
        '1000000000455 - $150'
      ].join('\n')
    );
  });

  it('groups by agent tag, uses full ids, and lists the untagged last', () => {
    expect(buildTeamAgentTopupListByLabel(space(), 'No tag')).toBe(
      [
        '#2',
        '1000000000434 - $50',
        '1000000000455 - $150',
        '',
        '#5',
        '1000000000455 - $150',
        '',
        'No tag',
        '1000000000117 - $100'
      ].join('\n')
    );
  });

  it('counts what a copy would list, and copies nothing when nothing is owed', () => {
    expect(countTeamAgentTopups(space())).toBe(3);
    const empty = space().map(account => ({
      ...account,
      agents: account.agents.map(agent => ({ ...agent, topup: null }))
    }));
    expect(countTeamAgentTopups(empty)).toBe(0);
    expect(buildTeamAgentTopupListByAccount(empty)).toBe('');
    expect(buildTeamAgentTopupListByLabel(empty, 'No tag')).toBe('');
  });

  it('reads a typed figure, refuses one that is not a figure, and steps by fifty', () => {
    expect(normalizeTeamAgentAmount('50')).toBe(50);
    expect(normalizeTeamAgentAmount('')).toBeNull();
    expect(normalizeTeamAgentAmount('12345')).toBeUndefined();
    expect(normalizeTeamAgentAmount('5o')).toBeUndefined();
    // Empty steps up to the first fifty and back down to empty.
    expect(stepTeamAgentTopup(null, 1)).toBe(50);
    expect(stepTeamAgentTopup(50, -1)).toBeNull();
    // A figure typed by hand snaps to the step rather than adding to it.
    expect(stepTeamAgentTopup(30, 1)).toBe(50);
    expect(stepTeamAgentTopup(120, 1)).toBe(150);
    expect(stepTeamAgentTopup(120, -1)).toBe(100);
  });
});
