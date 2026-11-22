import { describe, expect, it } from 'vitest';
import { parseAssistantPlan } from '@video-compressor/shared';
import { pickAdAccounts, runTool, type ToolDeps } from '../supabase/functions/assistant/tools';

/**
 * 064: the assistant's space tools. Reads answer with numbers Soty computed the way the Accounts
 * tab does; writes only prepare a card with what will change and the versions they saw.
 */
const TEAM = '00000000-0000-4000-8000-000000000001';
const A1 = '00000000-0000-4000-8000-0000000000a1';
const A2 = '00000000-0000-4000-8000-0000000000a2';
const A3 = '00000000-0000-4000-8000-0000000000a3';
const G18 = '00000000-0000-4000-8000-0000000000b1';
const G4 = '00000000-0000-4000-8000-0000000000b2';

const accounts = [
  {
    id: G18,
    name: 'g18',
    agents: [
      { id: A1, agent_id: '1111111244', labels: [{ id: 'l2', name: '#2' }] },
      {
        id: A2,
        agent_id: '2222222257',
        labels: [
          { id: 'l2', name: '#2' },
          { id: 'l1', name: '#1' }
        ]
      }
    ]
  },
  { id: G4, name: 'g4', agents: [{ id: A3, agent_id: '3333333999', labels: [] }] }
];

const field = (
  agent: string,
  date: string,
  metric: string,
  value: string | null,
  version = '3'
) => ({
  agentRowId: agent,
  date,
  metric,
  value,
  currency: 'USD',
  version,
  placementId: `p-${agent}`,
  updatedAt: '2026-11-21T10:00:00Z',
  updatedBy: null
});

function snapshot(from: string, to: string) {
  return {
    schemaVersion: 1,
    teamId: TEAM,
    teamName: 'Goor',
    from,
    to,
    currency: 'USD',
    generatedAt: '2026-11-22T10:00:00Z',
    accounts: [
      { id: G18, name: 'g18' },
      { id: G4, name: 'g4' }
    ],
    agents: [
      { id: A1, agentId: '1111111244' },
      { id: A2, agentId: '2222222257' },
      { id: A3, agentId: '3333333999' }
    ],
    placements: [A1, A2, A3].map(agent => ({
      id: `p-${agent}`,
      agentRowId: agent,
      accountId: agent === A3 ? G4 : G18,
      startsOn: '2026-11-01',
      endsOn: null,
      version: '1'
    })),
    fields: [
      field(A1, '2026-11-21', 'spend', '10.00'),
      field(A1, '2026-11-21', 'topup', '100.00'),
      field(A2, '2026-11-21', 'spend', '5.50'),
      field(A2, '2026-11-21', 'topup', '50.00'),
      field(A3, '2026-11-21', 'topup', '0.00'),
      field(A3, '2026-11-20', 'spend', '7.00')
    ].filter(f => f.date >= from && f.date <= to)
  };
}

const files = [
  {
    id: 'm16',
    name: 'TR_16.mp4',
    kind: 'video',
    category: 'video',
    parentFolderId: 'drive-root',
    tags: ['test'],
    offer: 'ProCaps TR',
    geo: 'TR'
  },
  {
    id: 'm23',
    name: 'TR_23.mp4',
    kind: 'video',
    category: 'video',
    parentFolderId: 'drive-tr',
    tags: [],
    offer: 'ProCaps TR',
    geo: 'TR'
  },
  {
    id: 'm25a',
    name: 'TR_25.mp4',
    kind: 'video',
    category: 'video',
    parentFolderId: 'drive-root',
    tags: [],
    offer: null,
    geo: null
  },
  {
    id: 'm25b',
    name: 'TR 25.mp4',
    kind: 'video',
    category: 'video',
    parentFolderId: 'drive-old',
    tags: [],
    offer: null,
    geo: null
  }
];

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

function deps(extra: Record<string, (args: Record<string, unknown>) => unknown> = {}): ToolDeps {
  calls.length = 0;
  const table: Record<string, (args: Record<string, unknown>) => unknown> = {
    list_team_accounts: () => accounts,
    get_team_agent_finance_v2: args => snapshot(String(args.p_from), String(args.p_to)),
    search_materials: args => {
      const query = String(args.p_query ?? '')
        .toLowerCase()
        .replace(/[\s_]/gu, '');
      const items = files.filter(
        f => !query || f.name.toLowerCase().replace(/[\s_]/gu, '').includes(query)
      );
      return { items, total: items.length };
    },
    list_team_folder_tree: () => [
      { id: 'f-tr', drive_file_id: 'drive-tr', parent_folder_id: 'drive-root', name: 'TR' },
      { id: 'f-old', drive_file_id: 'drive-old', parent_folder_id: 'drive-root', name: 'old' }
    ],
    list_team_product_catalogs: () => [
      {
        catalog_id: 'c1',
        name: 'TR_16_catalog',
        video_name: 'TR_16.mp4',
        folder_name: 'TR',
        product_count: 50,
        last_update_error: null
      },
      {
        catalog_id: 'c2',
        name: 'TR_23_catalog',
        video_name: 'TR_23.mp4',
        folder_name: 'TR',
        product_count: 50,
        last_update_error: 'SHEET_GONE'
      }
    ],
    list_team_members: () => [
      { user_id: 'u-owner', display_name: 'Roman', email: 'owner@example.com', role: 'owner' },
      {
        user_id: 'u-andrii',
        display_name: 'Андрій Кулік',
        email: 'andrii@example.com',
        role: 'editor'
      }
    ],
    list_team_labels: () => [{ id: 'tl-urgent', name: 'терміново' }],
    ...extra
  };
  return {
    teamId: TEAM,
    userId: 'u-owner',
    timezone: 'Europe/Kyiv',
    now: new Date('2026-11-22T10:00:00Z'),
    callerRpc: async (name, args) => {
      calls.push({ name, args });
      const handler = table[name];
      return handler
        ? { data: handler(args), error: null }
        : { data: null, error: { message: 'NOT_FOUND' } };
    }
  };
}

const arg = (name: string, value: unknown) => ({ name, value }) as never;

describe('reading money', () => {
  it('answers «скільки витрат за вчора» with the Accounts totals', async () => {
    const card = await runTool('finance_report', [arg('date', 'yesterday')], deps());
    expect(card.kind).toBe('table');
    expect(card.payload).toMatchObject({
      from: '2026-11-21',
      to: '2026-11-21',
      total: ['15.50', '150.00']
    });
  });

  it('groups by tags without counting an ad account twice', async () => {
    const card = await runTool(
      'finance_report',
      [arg('from', '2026-11-20'), arg('to', '2026-11-21'), arg('by', 'tag')],
      deps()
    );
    expect(card.payload.rows).toEqual([
      ['#1 + #2', '5.50', '50.00'],
      ['#2', '10.00', '100.00'],
      ['{untagged}', '7.00', '0.00']
    ]);
    expect(card.payload.total).toEqual(['22.50', '150.00']);
  });

  it('narrows to an account and refuses a future day or a too long period', async () => {
    const card = await runTool(
      'finance_report',
      [arg('date', '2026-11-21'), arg('scope', ['g4'])],
      deps()
    );
    expect(card.payload.total).toEqual([null, '0.00']);
    const future = await runTool('finance_report', [arg('date', '2026-11-23')], deps());
    expect(future.payload.unresolved).toEqual([
      { field: 'finance_report', written: '2026-11-23', code: 'FUTURE_FINANCE_DATE' }
    ]);
    const long = await runTool(
      'finance_report',
      [arg('from', '2026-01-01'), arg('to', '2026-11-21')],
      deps()
    );
    expect((long.payload.unresolved as Array<{ code: string }>)[0]!.code).toBe('PERIOD_TOO_LONG');
  });

  it('gives a statement of top-ups by tags with a text to copy, zeros left out', async () => {
    const card = await runTool(
      'topup_statement',
      [arg('date', 'yesterday'), arg('by', 'tag')],
      deps()
    );
    expect(card.payload.rows).toEqual([
      ['#1 + #2', '1', '50.00'],
      ['#2', '1', '100.00']
    ]);
    expect(card.payload.copyText).toBe(
      '2026-11-21 · USD\n\n#1 + #2 — $50\n2222222257 - $50\n\n#2 — $100\n1111111244 - $100\n\nΣ $150'
    );
  });
});

describe('recording money', () => {
  it('prepares each cell with the value it holds and its version', async () => {
    const card = await runTool(
      'set_finance',
      [
        arg('metric', 'topup'),
        arg('date', 'yesterday'),
        arg('entries', ['g18-244=120', 'g4 = 30,5'])
      ],
      deps()
    );
    expect(card.kind).toBe('review');
    expect(card.payload).toMatchObject({
      purpose: 'tool',
      tool: 'set_finance',
      date: '2026-11-21',
      total: '150.50',
      overwrites: 2
    });
    expect(card.payload.items).toEqual([
      expect.objectContaining({
        agentRowId: A1,
        from: '100.00',
        to: '120.00',
        version: '3',
        placementId: `p-${A1}`
      }),
      expect.objectContaining({ agentRowId: A3, from: '0.00', to: '30.50', version: '3' })
    ]);
  });

  it('marks an equal value as unchanged and refuses one ad account named twice', async () => {
    const same = await runTool(
      'set_finance',
      [arg('date', '2026-11-21'), arg('amount', '100'), arg('scope', ['g18-244'])],
      deps()
    );
    expect((same.payload.items as Array<{ unchanged: boolean }>)[0]!.unchanged).toBe(true);
    const twice = await runTool(
      'set_finance',
      [arg('entries', ['g18-244=1', '1111111244=2'])],
      deps()
    );
    expect((twice.payload.unresolved as Array<{ code: string }>)[0]!.code).toBe('DUPLICATE_TARGET');
  });

  it('reads ad accounts by all, account, label, full id, digits and tag', () => {
    const all = [
      {
        id: A1,
        agentId: '1111111244',
        account: 'g18',
        accountId: G18,
        label: 'g18-244',
        tags: ['#2']
      },
      {
        id: A2,
        agentId: '2222222257',
        account: 'g18',
        accountId: G18,
        label: 'g18-257',
        tags: ['#2', '#1']
      },
      { id: A3, agentId: '3333333999', account: 'g4', accountId: G4, label: 'g4-999', tags: [] }
    ];
    expect(pickAdAccounts(all, ['всі']).picked).toHaveLength(3);
    expect(pickAdAccounts(all, ['G18']).picked.map(a => a.id)).toEqual([A1, A2]);
    expect(pickAdAccounts(all, ['g18-257', '3333333999']).picked.map(a => a.id)).toEqual([A2, A3]);
    expect(pickAdAccounts(all, ['tag:#1']).picked.map(a => a.id)).toEqual([A2]);
    expect(pickAdAccounts(all, ['#2']).picked.map(a => a.id)).toEqual([A1, A2]);
    expect(pickAdAccounts(all, ['999']).picked.map(a => a.id)).toEqual([A3]);
    expect(pickAdAccounts(all, ['g99']).missing).toEqual(['g99']);
  });
});

describe('files and folders', () => {
  it('moves into a folder that does not exist yet, and reports a name that fits two files', async () => {
    const card = await runTool(
      'move_materials',
      [arg('items', ['тр16', 'TR_16', 'TR_25']), arg('destination', 'Нові')],
      deps()
    );
    // «тр16» is not a file name; the model writes it as TR_16 (the prompt rule), Soty matches loosely.
    expect(card.payload).toMatchObject({ destination: { create: 'Нові', parentId: null } });
    expect((card.payload.items as Array<{ id: string }>).map(i => i.id)).toEqual(['m16']);
    expect(card.payload.missing).toEqual(['тр16', 'TR_25 (2)']);
  });

  it('does not offer to move a folder — Soty moves files only, as the explorer does', async () => {
    const only = await runTool(
      'move_materials',
      [arg('items', ['old']), arg('destination', 'TR')],
      deps({
        search_materials: () => ({
          items: [
            {
              id: 'f-old',
              name: 'old',
              kind: 'folder',
              category: null,
              parentFolderId: 'drive-root',
              tags: []
            }
          ],
          total: 1
        })
      })
    );
    expect(only.payload.unresolved).toEqual([
      { field: 'move_materials', written: 'old', code: 'FOLDER_MOVE_UNSUPPORTED' }
    ]);
  });

  it('leaves out what is already in the destination', async () => {
    const card = await runTool(
      'move_materials',
      [arg('items', ['TR_16', 'TR_23']), arg('destination', 'TR')],
      deps()
    );
    expect(card.payload).toMatchObject({
      destination: { id: 'f-tr', driveId: 'drive-tr', label: 'TR' },
      already: 1
    });
    expect((card.payload.items as Array<{ id: string }>).map(i => i.id)).toEqual(['m16']);
  });

  it('renames a selection by a template, keeping the extension', async () => {
    const card = await runTool(
      'rename_materials',
      [arg('query', 'TR'), arg('in_folder', '/'), arg('template', 'ProCaps_{n}'), arg('start', 3)],
      deps()
    );
    expect(
      (card.payload.items as Array<{ from: string; to: string }>).map(i => [i.from, i.to])
    ).toEqual([
      ['TR 25.mp4', 'ProCaps_3.mp4'],
      ['TR_16.mp4', 'ProCaps_4.mp4'],
      ['TR_23.mp4', 'ProCaps_5.mp4'],
      ['TR_25.mp4', 'ProCaps_6.mp4']
    ]);
  });

  it('refuses a rule that gives two files the same name', async () => {
    const card = await runTool(
      'rename_materials',
      [arg('query', 'TR'), arg('in_folder', '/'), arg('template', 'same')],
      deps()
    );
    expect((card.payload.unresolved as Array<{ code: string }>)[0]!.code).toBe('NAME_CONFLICT');
  });

  it('adds a tag without dropping the ones a file has', async () => {
    const card = await runTool(
      'edit_materials',
      [arg('items', ['TR_16', 'TR_23']), arg('add_tags', ['test'])],
      deps()
    );
    expect(
      (card.payload.items as Array<{ id: string; patch: unknown }>).map(i => [i.id, i.patch])
    ).toEqual([['m23', { tags: ['test'] }]]);
  });
});

describe('catalogs, people and tasks', () => {
  it('«видали всі каталоги» lists every catalog on a red card', async () => {
    const card = await runTool('trash_catalogs', [arg('scope', 'all')], deps());
    expect(card.payload).toMatchObject({ tool: 'trash_catalogs', danger: true });
    expect((card.payload.items as Array<{ id: string }>).map(i => i.id)).toEqual(['c1', 'c2']);
    const broken = await runTool('trash_catalogs', [arg('scope', 'errors')], deps());
    expect((broken.payload.items as Array<{ id: string }>).map(i => i.id)).toEqual(['c2']);
  });

  it('never touches the owner and does not invite a member again', async () => {
    const owner = await runTool(
      'change_members',
      [arg('people', ['Roman']), arg('remove', true)],
      deps()
    );
    expect((owner.payload.unresolved as Array<{ code: string }>)[0]!.code).toBe(
      'OWNER_TRANSFER_REQUIRED'
    );
    const role = await runTool(
      'change_members',
      [arg('people', ['Андрій']), arg('role', 'admin')],
      deps()
    );
    expect(role.payload).toMatchObject({
      tool: 'change_roles',
      items: [{ id: 'u-andrii', from: 'editor', to: 'admin' }]
    });
    const invite = await runTool(
      'invite_members',
      [arg('emails', ['andrii@example.com', 'New@Example.com'])],
      deps()
    );
    expect(invite.payload).toMatchObject({
      items: [{ email: 'new@example.com' }],
      already: ['andrii@example.com']
    });
  });

  it('reads a task line: title, assignee, date, tags (new ones to create), files', async () => {
    const card = await runTool(
      'create_tasks',
      [arg('tasks', ['Перезалити тр16 | Андрій | tomorrow | терміново, нове | TR_16'])],
      deps()
    );
    expect(card.payload.items).toEqual([
      expect.objectContaining({
        title: 'Перезалити тр16',
        assigneeId: 'u-andrii',
        date: '2026-11-23',
        tags: [
          { id: 'tl-urgent', name: 'терміново' },
          { id: null, name: 'нове' }
        ],
        materials: [{ id: 'm16', label: 'TR_16.mp4' }]
      })
    ]);
  });

  it('«на мене» is the person writing', async () => {
    const card = await runTool(
      'create_tasks',
      [arg('tasks', ['Перевірити | me | tomorrow | |']), arg('x', null)],
      deps()
    );
    expect(card.payload.items).toEqual([
      expect.objectContaining({ assigneeId: 'u-owner', assignee: 'Roman' })
    ]);
  });

  it('answers an unknown tool with a problem, not a crash', async () => {
    const card = await runTool('format_disk', [], deps());
    expect(card.payload.unresolved).toEqual([
      { field: 'format_disk', written: 'format_disk', code: 'UNKNOWN_TOOL' }
    ]);
  });
});

describe('the plan contract', () => {
  it('carries a tool and its arguments; a tool step without a tool is dropped', () => {
    const base = {
      offer: null,
      count: null,
      accounts: [],
      fields: [],
      overrides: [],
      rows: [],
      dates: null,
      base: null,
      baseRow: null,
      question: null,
      notesFrom: null,
      notesLanguage: null
    };
    const plan = parseAssistantPlan({
      reply: 'Ось витрати.',
      actions: [
        {
          ...base,
          type: 'use_tool',
          tool: 'finance_report',
          args: [{ name: 'date', value: '2026-11-21' }]
        },
        { ...base, type: 'use_tool', tool: null, args: [] }
      ]
    });
    expect(plan?.actions).toHaveLength(1);
    expect(plan?.actions[0]).toMatchObject({
      tool: 'finance_report',
      args: [{ name: 'date', value: '2026-11-21' }]
    });
  });
});
