// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 064: a tool card's button goes through the screens' own client calls, row by row, and counts
 * what failed instead of stopping the rest.
 */
const team = vi.hoisted(() => ({
  ensureUploadFolder: vi.fn(async () => ({
    folderId: 'drive-new',
    materialId: 'm-new',
    name: 'Нові',
    created: true
  })),
  createTaskLabel: vi.fn(async (input: { name: string }) => ({ id: `new-${input.name}` })),
  listTaskLabels: vi.fn(async () => []),
  attachAgentLabel: vi.fn(async () => ({})),
  detachAgentLabel: vi.fn(async () => ({})),
  listMembers: vi.fn(async () => [{ userId: 'u1', permissionOverrides: { delete: true } }]),
  updateMembership: vi.fn(async () => ({})),
  trashMaterial: vi.fn(async () => ({})),
  createTask: vi.fn(async () => ({ id: 't1' })),
  updateTask: vi.fn(async () => ({})),
  attachTaskLabel: vi.fn(async () => []),
  attachTaskMaterials: vi.fn(async () => ({})),
  deleteTask: vi.fn(async () => true as const),
  addAccountAgent: vi.fn(async () => ({})),
  restoreMaterial: vi.fn(async () => ({})),
  setCatalogUpdateInterval: vi.fn(async () => ({}))
}));
const workspace = vi.hoisted(() => ({
  preflight: vi.fn(async () => ({ lifecycleVersion: '7', token: 'tok' })),
  archive: vi.fn(async () => ({}))
}));
const launchesApi = vi.hoisted(() => ({ editDictionary: vi.fn(async () => ({})) }));
vi.mock('../apps/web/src/api/team-accounts-workspace', () => ({ accountsWorkspaceApi: workspace }));
vi.mock('../apps/web/src/api/launches', () => ({ launchApi: launchesApi }));
const finance = vi.hoisted(() => ({ set: vi.fn(async () => ({})) }));
const move = vi.hoisted(() =>
  vi.fn(async (input: { items: unknown[] }) => ({
    completed: input.items.length,
    failed: 0,
    total: input.items.length,
    error: null,
    affectedFolderIds: []
  }))
);
vi.mock('../apps/web/src/api/team', () => ({ teamApi: team }));
vi.mock('../apps/web/src/api/team-finance', () => ({ teamFinanceApi: finance }));
vi.mock('../apps/web/src/team/explorer/moveCoordinator', () => ({ moveWorkspaceMaterials: move }));
vi.mock('../apps/web/src/team/materials/tail', () => ({
  renameMaterialWithTail: vi.fn(async () => ({})),
  trashMaterialWithTail: vi.fn(async () => undefined)
}));

import { runToolCard } from '../apps/web/src/team/assistant/tool-runner';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tool cards in the browser', () => {
  it('records money with the version and placement the card saw, skipping unchanged cells', async () => {
    const outcome = await runToolCard('team', 'card', {
      tool: 'set_finance',
      metric: 'topup',
      date: '2026-11-21',
      timezone: 'Europe/Kyiv',
      items: [
        {
          label: 'g18-244',
          agentRowId: 'a1',
          to: '120.00',
          version: '3',
          placementId: 'p1',
          unchanged: false
        },
        {
          label: 'g18-257',
          agentRowId: 'a2',
          to: '50.00',
          version: '4',
          placementId: 'p2',
          unchanged: true
        }
      ]
    });
    expect(outcome).toEqual({ done: 1, failed: 0, code: null });
    expect(finance.set).toHaveBeenCalledWith(
      'team',
      'a1',
      '2026-11-21',
      'topup',
      '120.00',
      '3',
      'Europe/Kyiv',
      expect.any(String),
      'p1'
    );
  });

  it('counts a refused cell and goes on with the rest', async () => {
    finance.set.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'FINANCE_CONFLICT' }));
    const outcome = await runToolCard('team', 'card', {
      tool: 'set_finance',
      metric: 'spend',
      date: '2026-11-21',
      timezone: 'UTC',
      items: [
        { label: 'a', agentRowId: 'a1', to: '1.00', version: '1', placementId: 'p1' },
        { label: 'b', agentRowId: 'a2', to: '2.00', version: '1', placementId: 'p2' }
      ]
    });
    expect(outcome).toEqual({ done: 1, failed: 1, code: 'FINANCE_CONFLICT' });
  });

  it('makes a missing destination folder first, then moves as the explorer does', async () => {
    await runToolCard('team', 'card-1', {
      tool: 'move_materials',
      destination: { create: 'Нові', parentId: null, label: 'Нові' },
      items: [{ label: 'TR_16.mp4', id: 'm16', category: 'video' }]
    });
    expect(team.ensureUploadFolder).toHaveBeenCalledWith('team', {
      name: 'Нові',
      parentMaterialId: null,
      idempotencyKey: 'card-1:destination'
    });
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationFolderId: 'drive-new',
        conflictMode: 'keep_both',
        items: [{ id: 'm16', name: 'TR_16.mp4', category: 'video' }]
      })
    );
  });

  it('creates a missing tag once and puts it on every ad account', async () => {
    await runToolCard('team', 'card', {
      tool: 'tag_ad_accounts',
      items: [
        { label: 'g18-244', id: 'a1', add: [{ id: null, name: '#3' }], remove: [] },
        {
          label: 'g18-257',
          id: 'a2',
          add: [{ id: null, name: '#3' }],
          remove: [{ id: 'l1', name: '#1' }]
        }
      ]
    });
    expect(team.createTaskLabel).toHaveBeenCalledTimes(1);
    expect(team.attachAgentLabel).toHaveBeenCalledWith({
      teamId: 'team',
      agentRowId: 'a2',
      labelId: 'new-#3'
    });
    expect(team.detachAgentLabel).toHaveBeenCalledWith({
      teamId: 'team',
      agentRowId: 'a2',
      labelId: 'l1'
    });
  });

  it('changes a role and keeps the person’s own extra rights', async () => {
    await runToolCard('team', 'card', {
      tool: 'change_roles',
      role: 'admin',
      items: [{ label: 'Андрій', id: 'u1' }]
    });
    expect(team.updateMembership).toHaveBeenCalledWith({
      teamId: 'team',
      userId: 'u1',
      baseRole: 'admin',
      permissionOverrides: { delete: true }
    });
  });

  it('puts catalogs into the trash with a key per catalog', async () => {
    const outcome = await runToolCard('team', 'cat', {
      tool: 'trash_catalogs',
      items: [
        { label: 'TR_16_catalog', id: 'c1' },
        { label: 'TR_23_catalog', id: 'c2' }
      ]
    });
    expect(outcome.done).toBe(2);
    expect(team.trashMaterial).toHaveBeenCalledWith({
      teamId: 'team',
      materialId: 'c2',
      idempotencyKey: 'cat:catalog:1'
    });
  });

  it('makes the missing parent once, then the folders in it', async () => {
    await runToolCard('team', 'card-2', {
      tool: 'create_folders',
      parent: { create: 'Нові', parentId: 'f-tr', label: 'TR / Нові' },
      items: [
        { label: 'a', name: 'a', exists: false },
        { label: 'b', name: 'b', exists: false }
      ]
    });
    expect(team.ensureUploadFolder).toHaveBeenNthCalledWith(1, 'team', {
      name: 'Нові',
      parentMaterialId: 'f-tr',
      idempotencyKey: 'card-2:parent'
    });
    expect(team.ensureUploadFolder).toHaveBeenNthCalledWith(3, 'team', {
      name: 'b',
      parentMaterialId: 'm-new',
      idempotencyKey: 'card-2:folder:1'
    });
  });

  it('deletes each task through the Tasks client', async () => {
    const outcome = await runToolCard('team', 'card', {
      tool: 'delete_tasks',
      items: [{ label: 'A', id: 't1' }]
    });
    expect(outcome.done).toBe(1);
    expect(team.deleteTask).toHaveBeenCalledWith({ teamId: 'team', taskId: 't1' });
  });

  it('archives an account through its lifecycle token, as Accounts does', async () => {
    await runToolCard('team', 'card', {
      tool: 'archive_accounts',
      items: [{ label: 'g4', kind: 'social', id: 'acc-4' }]
    });
    expect(workspace.preflight).toHaveBeenCalledWith('team', 'social', 'acc-4');
    expect(workspace.archive).toHaveBeenCalledWith(
      'team',
      'social',
      'acc-4',
      true,
      '7',
      'tok',
      expect.any(String)
    );
  });

  it('adds only the ad accounts the account lacks', async () => {
    await runToolCard('team', 'card', {
      tool: 'add_ad_accounts',
      account: { id: 'acc-4', label: 'g4' },
      items: [
        { label: 'g4-999', agentId: '3333333999', exists: true },
        { label: 'g4-123', agentId: '5555555123', exists: false }
      ]
    });
    expect(team.addAccountAgent).toHaveBeenCalledTimes(1);
    expect(team.addAccountAgent).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-4', agentId: '5555555123' })
    );
  });

  it('turns the catalog refresh off for all the listed catalogs at once', async () => {
    await runToolCard('team', 'card', {
      tool: 'catalog_interval',
      interval: null,
      items: [
        { label: 'a', id: 'c1' },
        { label: 'b', id: 'c2' }
      ]
    });
    expect(team.setCatalogUpdateInterval).toHaveBeenCalledWith('team', ['c1', 'c2'], null);
  });

  it('renames an offer with the version it was read at', async () => {
    await runToolCard('team', 'card', {
      tool: 'edit_offers',
      items: [
        {
          label: 'ProCaps TR',
          id: 'o1',
          updatedAt: 'u1',
          operation: 'rename',
          to: 'ProCaps TR old'
        }
      ]
    });
    expect(launchesApi.editDictionary).toHaveBeenCalledWith(
      'team',
      'offers',
      { id: 'o1', value: 'ProCaps TR', updatedAt: 'u1' },
      'rename',
      'ProCaps TR old',
      expect.any(String)
    );
  });

  it('creates a task with its day, tags and files', async () => {
    await runToolCard('team', 'card', {
      tool: 'create_tasks',
      items: [
        {
          label: 'Перезалити',
          title: 'Перезалити',
          assigneeId: 'u1',
          date: '2026-11-23',
          tags: [{ id: 'tl', name: 'терміново' }],
          materials: [{ id: 'm16', label: 'TR_16.mp4' }]
        }
      ]
    });
    expect(team.createTask).toHaveBeenCalledWith({
      teamId: 'team',
      title: 'Перезалити',
      assigneeId: 'u1'
    });
    expect(team.updateTask).toHaveBeenCalledWith('team', 't1', { dateOn: '2026-11-23' });
    expect(team.attachTaskLabel).toHaveBeenCalledWith({
      teamId: 'team',
      taskId: 't1',
      labelId: 'tl'
    });
    expect(team.attachTaskMaterials).toHaveBeenCalledWith({
      teamId: 'team',
      taskId: 't1',
      materialIds: ['m16']
    });
  });
});
