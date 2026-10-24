// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchSpace } from '../apps/web/src/team/launches/LaunchSpace';
import { teamApi } from '../apps/web/src/api/team';
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import { quickRangeValue } from '../apps/web/src/team/tasks/useTasks';
import { launchConfig, launchSources } from './fixtures/launches';
import { launchPreview, type LaunchDetail } from '../packages/shared/src/team/launches';
const TEAM = '79999999-0000-4000-8000-000000000001';
const LAUNCH = '79999999-0000-4000-8000-000000000002';
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
function mockClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}
const seams = vi.hoisted(() => ({
  actor: 'actor-a',
  revision: 0,
  view: true,
  edit: false,
  manage: false,
  delete: false,
  archiveWarning: vi.fn(),
  archive: vi.fn(),
  copy: vi.fn(),
  defaults: vi.fn(),
  setDefaults: vi.fn(),
  realGeneration: false,
  editorMounts: 0,
  detail: vi.fn(),
  history: vi.fn(),
  save: vi.fn(),
  saveWorkingCopy: vi.fn(),
  generate: vi.fn(),
  selection: vi.fn(),
  list: vi.fn(),
  metadata: vi.fn(),
  members: [] as Array<{ userId: string; displayName: string }>,
  accounts: [] as unknown[],
  offers: [] as unknown[],
  buyers: [] as unknown[]
}));
vi.mock('../apps/web/src/auth/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: seams.actor } })
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({
    revision: seams.revision,
    can: (permission: string) =>
      permission === 'view'
        ? seams.view
        : permission === 'edit'
          ? seams.edit
          : permission === 'manage_metadata'
            ? seams.manage
            : permission === 'delete'
              ? seams.delete
              : false
  })
}));
vi.mock('../apps/web/src/api/team', () => ({
  launchApi: {
    assignees: async () => seams.members,
    accounts: async () => seams.accounts,
    dictionaries: async () => ({ offers: seams.offers, buyers: seams.buyers }),
    defaults: seams.defaults,
    setDefaults: seams.setDefaults,
    list: seams.list,
    metadata: seams.metadata,
    detail: seams.detail,
    history: seams.history,
    save: seams.save,
    saveWorkingCopy: seams.saveWorkingCopy,
    generate: seams.generate,
    archiveWarning: seams.archiveWarning,
    archive: seams.archive,
    copy: seams.copy,
    selection: seams.selection
  },
  teamApi: {
    listMembers: vi.fn(async () => seams.members),
    listAssignees: vi.fn(async () => seams.members)
  },
  TeamApiError: class extends Error {
    constructor(
      public code: string,
      public retryable: boolean
    ) {
      super(code);
    }
  }
}));
vi.mock('../apps/web/src/team/launches/useLaunchGeneration', async () => {
  const actual = await vi.importActual<
    typeof import('../apps/web/src/team/launches/useLaunchGeneration')
  >('../apps/web/src/team/launches/useLaunchGeneration');
  return {
    useLaunchGeneration: (...args: Parameters<typeof actual.useLaunchGeneration>) =>
      seams.realGeneration
        ? actual.useLaunchGeneration(...args)
        : { busy: false, hasUnresolvedRequest: false }
  };
});
vi.mock('../apps/web/src/team/launches/LaunchEditor', () => ({
  LaunchEditor: ({
    config,
    onChange,
    disabled
  }: {
    config: { originalUrl: string; age: number; launchDate: string; maxBudget: number };
    onChange: (patch: { age?: number; originalUrl?: string }) => void;
    disabled: boolean;
  }) => {
    React.useEffect(() => {
      seams.editorMounts++;
    }, []);
    return (
      <div>
        {config.originalUrl}
        <span>Age: {config.age}</span>
        <span>Date: {config.launchDate}</span>
        <span>Max budget: {config.maxBudget}</span>
        <button disabled={disabled} onClick={() => onChange({ age: 50 })}>
          Age 50
        </button>
        <button
          disabled={disabled}
          onClick={() =>
            onChange({ originalUrl: 'https://example.invalid/?capi=SYNTHETIC_CANCEL_URL' })
          }
        >
          Synthetic URL
        </button>
      </div>
    );
  }
}));
vi.mock('../apps/web/src/team/launches/LaunchGenerationProgress', () => ({
  LaunchGenerationProgress: ({
    generation,
    onOpenRestitchSettings
  }: {
    generation: { errorCode?: string } | null;
    onOpenRestitchSettings: () => void;
  }) =>
    generation?.errorCode === 'RESTITCH_POOL_EMPTY' ? (
      <button onClick={onOpenRestitchSettings}>Choose re-stitching images</button>
    ) : null
}));
vi.mock('../apps/web/src/team/launches/analytics', () => ({
  launchIntent: vi.fn(),
  launchMutation: (_correlation: unknown, _action: unknown, execute: () => Promise<unknown>) =>
    execute(),
  launchAction: vi.fn(),
  launchLocalStage: vi.fn(),
  launchObservedGeneration: vi.fn(),
  launchVisible: vi.fn()
}));
seams.defaults.mockResolvedValue(null);
seams.list.mockResolvedValue({ items: [], nextCursor: null });
const query = { ...emptyTeamRouteQuery(), launchId: LAUNCH, launchTab: 'settings' as const };
function detail(secret: string) {
  return {
    id: LAUNCH,
    version: '1',
    draft: launchConfig({ originalUrl: secret }),
    expectedSourceSnapshot: null,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: null
  };
}
function clickLaunchClose() {
  const close = document.querySelector<HTMLButtonElement>('.launch-detail-close');
  if (!close) throw new Error('Launch close button is missing');
  fireEvent.click(close);
}
function resetSeams() {
  seams.actor = 'actor-a';
  seams.revision = 0;
  seams.view = true;
  seams.edit = false;
  seams.manage = false;
  seams.delete = false;
  seams.archiveWarning.mockReset();
  seams.archive.mockReset();
  seams.copy.mockReset();
  seams.defaults.mockReset().mockResolvedValue(null);
  seams.setDefaults.mockReset();
  seams.realGeneration = false;
  seams.editorMounts = 0;
  seams.accounts = [];
  seams.offers = [];
  seams.buyers = [];
  seams.members = [];
  vi.clearAllMocks();
  seams.detail.mockReset();
  seams.history.mockReset();
  seams.save.mockReset();
  seams.saveWorkingCopy.mockReset().mockResolvedValue({ id: LAUNCH, version: '2' });
  seams.generate.mockReset();
  seams.selection.mockReset().mockResolvedValue(null);
  seams.list.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  seams.metadata.mockReset();
}
beforeEach(resetSeams);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalClipboardDescriptor)
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
  resetSeams();
});
it('orders launch date shortcuts after the calendar and filters the server list by local day', async () => {
  render(<LaunchSpace teamId={TEAM} query={{ ...emptyTeamRouteQuery(), launchId: null }} />);
  const calendar = await screen.findByRole('button', { name: 'Open calendar' });
  expect(screen.queryByRole('group', { name: 'Status' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'To do' })).toBeNull();
  const yesterday = screen.getByRole('button', { name: 'Yesterday' });
  const today = screen.getByRole('button', { name: 'Today' });
  expect(
    calendar.compareDocumentPosition(yesterday) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(yesterday.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(today);
  const expected = quickRangeValue('today', new Date());
  if (expected.kind !== 'range') throw new Error('Today must resolve to a date range');
  await waitFor(() =>
    expect(seams.list).toHaveBeenLastCalledWith(TEAM, {
      search: '',
      from: expected.from,
      to: expected.to
    })
  );
  fireEvent.click(today);
  await waitFor(() => expect(seams.list).toHaveBeenLastCalledWith(TEAM, { search: '' }));
  fireEvent.click(yesterday);
  const prior = quickRangeValue('yesterday', new Date());
  if (prior.kind !== 'range') throw new Error('Yesterday must resolve to a date range');
  await waitFor(() =>
    expect(seams.list).toHaveBeenLastCalledWith(TEAM, {
      search: '',
      from: prior.from,
      to: prior.to
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear date filter' }));
  await waitFor(() => expect(seams.list).toHaveBeenLastCalledWith(TEAM, { search: '' }));
});
it('closes a clean new draft without an unsaved-change prompt', async () => {
  const { buildTeamRoute } = await import('../apps/web/src/team/routes');
  seams.edit = true;
  const path = buildTeamRoute({
    spaceId: TEAM,
    section: 'launches',
    query: { ...query, launchId: 'new', launchTab: 'settings' }
  });
  window.history.replaceState({}, '', path);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    render(
      <LaunchSpace teamId={TEAM} query={{ ...query, launchId: 'new', launchTab: 'settings' }} />
    );
    await screen.findByRole('dialog', { name: 'Launches' });
    expect(document.querySelector('.team-panel.team-launch-space')).toBeTruthy();
    expect(document.querySelector('.ui-overlay .team-launch-modal')).toBeTruthy();
    await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.location.search).not.toContain('launch=new');
    expect(confirm).not.toHaveBeenCalled();
  } finally {
    confirm.mockRestore();
    window.history.replaceState({}, '', '/');
  }
});
it('saves an edited new draft when clicking outside the dialog', async () => {
  const { buildTeamRoute } = await import('../apps/web/src/team/routes');
  seams.edit = true;
  const newQuery = { ...query, launchId: 'new', launchTab: 'settings' as const };
  const path = buildTeamRoute({ spaceId: TEAM, section: 'launches', query: newQuery });
  window.history.replaceState({}, '', path);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  seams.save.mockResolvedValue({ id: LAUNCH, version: '2' });
  seams.detail.mockResolvedValue(detail('https://example.invalid/?capi=SYNTHETIC_CANCEL_URL'));
  try {
    const view = render(<LaunchSpace teamId={TEAM} query={newQuery} />);
    await screen.findByRole('button', { name: 'Synthetic URL' });
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic URL' }));
    expect(screen.getByText('https://example.invalid/?capi=SYNTHETIC_CANCEL_URL')).toBeTruthy();
    const overlay = document.querySelector('.ui-overlay');
    if (!overlay) throw new Error('Launch dialog overlay is missing');
    fireEvent.mouseDown(overlay);
    await waitFor(() => expect(window.location.search).not.toContain('launch=new'));
    expect(seams.save).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    view.unmount();
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('SYNTHETIC_CANCEL_URL');
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain('SYNTHETIC_CANCEL_URL');
  } finally {
    confirm.mockRestore();
    window.history.replaceState({}, '', '/');
  }
});
it('starts retention warnings unchecked and does not persist suppression when canceled', async () => {
  seams.delete = true;
  seams.detail.mockResolvedValue(detail('SYNTHETIC_RETENTION_URL'));
  seams.archiveWarning.mockResolvedValue({
    hasCatalog: true,
    hasRestitch: true,
    suppressed: false
  });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_RETENTION_URL');
  fireEvent.click(screen.getByRole('button', { name: 'Delete launch' }));
  await screen.findByText('The catalog and restitched video will remain in the workspace.');
  const checkbox = screen.getByRole('checkbox', { name: 'Do not show again' }) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  fireEvent.click(checkbox);
  const cancel = screen.getAllByRole('button', { name: 'Cancel' });
  fireEvent.click(cancel[cancel.length - 1]);
  expect(seams.archive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete launch' }));
  await screen.findByText('The catalog and restitched video will remain in the workspace.');
  expect(
    (screen.getByRole('checkbox', { name: 'Do not show again' }) as HTMLInputElement).checked
  ).toBe(false);
});
it('retries a failed deletion with the same request and chosen retention preference', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.delete = true;
  seams.detail.mockResolvedValue(detail('SYNTHETIC_ARCHIVE_URL'));
  seams.archiveWarning.mockResolvedValue({
    hasCatalog: true,
    hasRestitch: false,
    suppressed: false
  });
  seams.archive
    .mockRejectedValueOnce(new TeamApiError('DRIVE_UNAVAILABLE', true))
    .mockResolvedValueOnce(undefined);
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_ARCHIVE_URL');
  fireEvent.click(screen.getByRole('button', { name: 'Delete launch' }));
  await screen.findByText('The catalog will remain in the workspace.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Do not show again' }));
  const buttons = screen.getAllByRole('button', { name: 'Delete launch' });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(seams.archive).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      (screen.getAllByRole('button', { name: 'Delete launch' })[0] as HTMLButtonElement).disabled
    ).toBe(false)
  );
  const first = [...seams.archive.mock.calls[0]];
  expect(first[4]).toBe(true);
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete launch' })[0]);
  await waitFor(() => expect(seams.archive).toHaveBeenCalledTimes(2));
  expect(seams.archive.mock.calls[1]).toEqual(first);
  expect(seams.archiveWarning).toHaveBeenCalledTimes(1);
});
it('locks copy and deletion while an authoritative generation is active', async () => {
  seams.edit = true;
  seams.delete = true;
  seams.detail.mockResolvedValue({
    ...detail('SYNTHETIC_ACTIVE_URL'),
    generation: { id: 'active-generation', state: 'running', stage: 'catalog_creating' }
  });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_ACTIVE_URL');
  expect((screen.getByRole('button', { name: 'Copy launch' }) as HTMLButtonElement).disabled).toBe(
    true
  );
  expect(
    (screen.getByRole('button', { name: 'Delete launch' }) as HTMLButtonElement).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Delete launch' }));
  expect(seams.archiveWarning).not.toHaveBeenCalled();
  expect(seams.archive).not.toHaveBeenCalled();
});
it('opens a copied Launch in settings without starting generation', async () => {
  seams.edit = true;
  seams.selection.mockResolvedValue(null);
  const copiedId = '79999999-0000-4000-8000-000000000003';
  seams.copy.mockResolvedValue({ id: copiedId });
  seams.detail.mockImplementation(async (_team: string, id: string) => ({
    ...detail('SYNTHETIC_COPY_URL'),
    id
  }));
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_COPY_URL');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Copy launch' }) as HTMLButtonElement).disabled
    ).toBe(false)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy launch' }));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('launch')).toBe(copiedId)
  );
  expect(new URLSearchParams(window.location.search).get('launchTab')).toBe('settings');
  expect(seams.copy).toHaveBeenCalledOnce();
  expect(seams.generate).not.toHaveBeenCalled();
});
it('switches to the result without a page view transition', async () => {
  const navigate = vi.fn();
  const config = launchConfig();
  const preview = launchPreview(config, launchSources);
  if (!preview.ok) throw new Error('fixture');
  seams.detail.mockResolvedValue({
    ...detail(config.originalUrl),
    activeRevision: {
      id: 'tab-switch-revision',
      revisionNo: 1,
      kind: 'generated',
      config,
      sources: launchSources,
      baselineRevisionId: null,
      baseline: preview.value,
      overrides: {},
      catalog: null,
      createdAt: '2026-10-15T00:00:00Z'
    }
  });
  window.addEventListener('wishly-navigation', navigate);
  try {
    render(<LaunchSpace teamId={TEAM} query={query} />);
    await screen.findByRole('tab', { name: 'Result' });
    fireEvent.click(screen.getByRole('tab', { name: 'Result' }));
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { animate: false } })
    );
  } finally {
    window.removeEventListener('wishly-navigation', navigate);
  }
});
it('retains approved unsaved outputs after a lost generation reply and discards them only when the same request succeeds', async () => {
  seams.edit = true;
  seams.realGeneration = true;
  const config = launchConfig();
  const sources = {
    ...launchSources,
    schemaVersion: 1 as const,
    agentRowId: config.agentRowId,
    offerId: config.offerId,
    buyerId: config.buyerId,
    materialId: config.materialId,
    catalogSettingsVersion: null
  };
  const initial = launchPreview(config, sources);
  if (!initial.ok) throw new Error('fixture');
  let current: LaunchDetail = {
    ...detail(config.originalUrl),
    workStatus: 'todo',
    expectedSourceSnapshot: sources,
    activeRevision: {
      id: 'original-revision',
      revisionNo: 1,
      kind: 'generated',
      config,
      sources,
      baselineRevisionId: null,
      baseline: initial.value,
      overrides: {},
      catalog: null,
      createdAt: '2026-10-13T10:00:00Z'
    }
  };
  seams.accounts = [
    {
      id: sources.accountId,
      name: sources.social,
      agents: [{ id: config.agentRowId, agentId: sources.agentId }]
    }
  ];
  seams.offers = [{ id: config.offerId, value: sources.offer }];
  seams.buyers = [{ id: config.buyerId, value: sources.buyer }];
  seams.detail.mockImplementation(async () => current);
  seams.save.mockImplementation(async (input: { config: typeof config }) => {
    current = { ...current, version: '2', draft: input.config };
    return { id: current.id, version: current.version };
  });
  seams.generate
    .mockRejectedValueOnce(new Error('network'))
    .mockImplementationOnce(async (_team, _id, version, key) => {
      const preview = launchPreview(current.draft as typeof config, sources);
      if (!preview.ok) throw new Error('fixture');
      current = {
        ...current,
        version: '3',
        generation: {
          id: 'generation',
          requestKey: key,
          inputVersion: version,
          state: 'succeeded',
          stage: 'result_committed',
          stateVersion: '2',
          progress: null,
          errorCode: null,
          childOperationIds: []
        },
        activeRevision: {
          ...current.activeRevision!,
          id: 'new-revision',
          revisionNo: 2,
          config: current.draft as typeof config,
          baseline: preview.value
        }
      };
      return {};
    });
  const view = render(<LaunchSpace teamId={TEAM} query={{ ...query, launchTab: 'result' }} />);
  await screen.findByRole('button', { name: 'Edit Campaign name #1' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit Campaign name #1' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Campaign name #1' }), {
    target: { value: 'manual_unsaved' }
  });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Campaign name #1' }), { key: 'Enter' });
  view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  // Editing can still be saving or refreshing sources. A real user can generate
  // only once the action is available; a click on the disabled button is ignored.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Generate launch' })).toHaveProperty(
      'disabled',
      false
    )
  );
  fireEvent.click(screen.getByRole('button', { name: 'Generate launch' }));
  await screen.findByRole('region', { name: 'Update launch?' });
  fireEvent.click(screen.getByRole('button', { name: 'Update launch' }));
  await waitFor(() => expect(seams.generate).toHaveBeenCalledOnce());
  await screen.findByRole('button', { name: 'Repeat' });
  view.rerender(<LaunchSpace teamId={TEAM} query={{ ...query, launchTab: 'result' }} />);
  await screen.findByText('manual_unsaved');
  fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
  await waitFor(() => expect(seams.generate).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('manual_unsaved')).toBeNull());
  expect(seams.save).toHaveBeenCalledOnce();
  expect(seams.generate.mock.calls[1]).toEqual(seams.generate.mock.calls[0]);
});
it('clears protected state immediately on actor change and waits for the new authorized read', async () => {
  let reply: (value: unknown) => void = () => {};
  seams.detail.mockResolvedValueOnce(detail('SYNTHETIC_ACTOR_A_URL')).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_ACTOR_A_URL');
  seams.actor = 'actor-b';
  view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
  expect(screen.queryByText('SYNTHETIC_ACTOR_A_URL')).toBeNull();
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
  await act(async () => {
    reply(detail('SYNTHETIC_ACTOR_B_URL'));
  });
  await screen.findByText('SYNTHETIC_ACTOR_B_URL');
});
it('hides protected detail when workspace view authority is revoked', async () => {
  seams.detail.mockResolvedValue(detail('SYNTHETIC_PRIVATE_URL'));
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_PRIVATE_URL');
  seams.view = false;
  view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
  expect(screen.queryByText('SYNTHETIC_PRIVATE_URL')).toBeNull();
});

it.each(['PERMISSION_DENIED', 'SPACE_BLOCKED', 'NOT_FOUND', 'INVALID_RESPONSE'] as const)(
  'drops protected detail when a revision refresh returns %s',
  async code => {
    const { TeamApiError } = await import('../apps/web/src/api/team');
    seams.detail.mockResolvedValueOnce(detail('SYNTHETIC_REVOKED_DETAIL_URL'));
    const view = render(<LaunchSpace teamId={TEAM} query={query} />);
    await screen.findByText('SYNTHETIC_REVOKED_DETAIL_URL');
    seams.detail.mockRejectedValueOnce(new TeamApiError(code, false));
    seams.revision++;
    view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
    await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('SYNTHETIC_REVOKED_DETAIL_URL')).toBeNull());
  }
);

it('keeps unsaved RAM edits after a retryable detail refresh error', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.edit = true;
  seams.detail.mockResolvedValueOnce(detail('SYNTHETIC_LOCAL_DRAFT_URL'));
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_LOCAL_DRAFT_URL');
  const age = screen.getByRole('button', { name: 'Age 50' });
  await waitFor(() => expect((age as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(age);
  expect(screen.getByText('Age: 50')).toBeTruthy();
  seams.detail.mockRejectedValueOnce(new TeamApiError('DRIVE_UNAVAILABLE', true));
  seams.revision++;
  view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
  expect(screen.getByText('SYNTHETIC_LOCAL_DRAFT_URL')).toBeTruthy();
  expect(screen.getByText('Age: 50')).toBeTruthy();
});

it('does not display a previous result while a different revision is loading', async () => {
  const currentConfig = launchConfig({ originalUrl: 'https://example.invalid/current-revision' });
  const oldConfig = launchConfig({ originalUrl: 'https://example.invalid/old-revision' });
  const currentPreview = launchPreview(currentConfig, launchSources);
  const oldPreview = launchPreview(oldConfig, launchSources);
  if (!currentPreview.ok || !oldPreview.ok) throw new Error('fixture');
  const revision = {
    id: 'current-revision',
    revisionNo: 2,
    kind: 'generated' as const,
    config: currentConfig,
    sources: launchSources,
    baselineRevisionId: null,
    baseline: currentPreview.value,
    overrides: {},
    catalog: null,
    createdAt: '2026-10-15T00:00:00Z'
  };
  const current: LaunchDetail = {
    ...detail(currentConfig.originalUrl),
    workStatus: 'todo',
    activeRevision: revision
  };
  const historical: LaunchDetail = {
    ...current,
    activeRevision: {
      ...revision,
      id: 'old-revision',
      revisionNo: 1,
      config: oldConfig,
      baseline: oldPreview.value
    }
  };
  let resolveHistorical!: (value: LaunchDetail) => void;
  seams.detail
    .mockResolvedValueOnce(current)
    .mockImplementationOnce(() => new Promise(resolve => (resolveHistorical = resolve)));
  const view = render(<LaunchSpace teamId={TEAM} query={{ ...query, launchTab: 'result' }} />);
  await screen.findByText(currentPreview.value.advertisingUrl);
  view.rerender(
    <LaunchSpace
      teamId={TEAM}
      query={{ ...query, launchTab: 'result', revisionId: 'old-revision' }}
    />
  );
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(currentPreview.value.advertisingUrl)).toBeNull();
  await act(async () => resolveHistorical(historical));
  await screen.findByText(oldPreview.value.advertisingUrl);
  let resolveCurrent!: (value: LaunchDetail) => void;
  seams.detail.mockImplementationOnce(() => new Promise(resolve => (resolveCurrent = resolve)));
  view.rerender(<LaunchSpace teamId={TEAM} query={{ ...query, launchTab: 'result' }} />);
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(3));
  expect(screen.queryByText(oldPreview.value.advertisingUrl)).toBeNull();
  await act(async () => resolveCurrent(current));
  await screen.findByText(currentPreview.value.advertisingUrl);
});

it('requires confirmation before a dirty draft switches to another revision', async () => {
  const { buildTeamRoute } = await import('../apps/web/src/team/routes');
  const { navigateTo } = await import('../apps/web/src/lib/navigation');
  seams.edit = true;
  seams.detail.mockResolvedValue(detail('SYNTHETIC_UNSAVED_REVISION_URL'));
  const currentPath = buildTeamRoute({ spaceId: TEAM, section: 'launches', query });
  const historicalPath = buildTeamRoute({
    spaceId: TEAM,
    section: 'launches',
    query: { ...query, revisionId: 'old-revision' }
  });
  window.history.replaceState({}, '', currentPath);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  try {
    render(<LaunchSpace teamId={TEAM} query={query} />);
    await screen.findByText('SYNTHETIC_UNSAVED_REVISION_URL');
    fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
    navigateTo(historicalPath);
    expect(window.location.pathname + window.location.search).toBe(currentPath);
    expect(screen.getByText('Age: 50')).toBeTruthy();
    navigateTo(historicalPath);
    expect(window.location.pathname + window.location.search).toBe(historicalPath);
    expect(confirm).toHaveBeenCalledTimes(2);
  } finally {
    confirm.mockRestore();
    window.history.replaceState({}, '', '/');
  }
});

it('guards a browser history navigation away from a dirty Launch draft', async () => {
  const { useBrowserRoute } = await import('../apps/web/src/lib/navigation');
  const { buildTeamRoute, parseTeamRoute } = await import('../apps/web/src/team/routes');
  seams.edit = true;
  const listPath = buildTeamRoute({
    spaceId: TEAM,
    section: 'launches',
    query: { ...query, launchId: null, launchTab: null }
  });
  const draftPath = buildTeamRoute({
    spaceId: TEAM,
    section: 'launches',
    query: { ...query, launchId: 'new', launchTab: 'settings' }
  });
  window.history.replaceState({}, '', draftPath);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  function Host() {
    const parsed = parseTeamRoute(useBrowserRoute());
    return parsed?.kind === 'space' ? <LaunchSpace teamId={TEAM} query={parsed.query} /> : null;
  }
  try {
    render(<Host />);
    await screen.findByRole('button', { name: 'Age 50' });
    fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
    window.history.replaceState({}, '', listPath);
    fireEvent(window, new PopStateEvent('popstate'));
    expect(window.location.pathname + window.location.search).toBe(draftPath);
    expect(screen.getByText('Age: 50')).toBeTruthy();
    window.history.replaceState({}, '', listPath);
    fireEvent(window, new PopStateEvent('popstate'));
    expect(window.location.pathname + window.location.search).toBe(listPath);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Age 50' })).toBeNull());
    expect(confirm).toHaveBeenCalledTimes(2);
  } finally {
    confirm.mockRestore();
    window.history.replaceState({}, '', '/');
  }
});

it('refreshes active assignee choices after a member is revoked in another session', async () => {
  seams.edit = true;
  seams.members = [{ userId: 'member-a', displayName: 'Member A' }];
  const listQuery = emptyTeamRouteQuery();
  const view = render(<LaunchSpace teamId={TEAM} query={listQuery} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Filters' }));
  const filter = screen.getByRole('button', { name: 'Assignee' });
  fireEvent.click(filter);
  expect(screen.getByRole('option', { name: 'Member A' })).toBeTruthy();
  fireEvent.click(screen.getByRole('option', { name: 'Member A' }));
  await waitFor(() =>
    expect(seams.list).toHaveBeenCalledWith(
      TEAM,
      expect.objectContaining({ assigneeId: 'member-a' })
    )
  );
  seams.members = [];
  seams.revision++;
  view.rerender(<LaunchSpace teamId={TEAM} query={listQuery} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Assignee' }).textContent).toContain('All')
  );
  fireEvent.click(screen.getByRole('button', { name: 'Assignee' }));
  expect(screen.queryByRole('option', { name: 'Member A' })).toBeNull();
  expect(seams.metadata).not.toHaveBeenCalled();
});

it('does not show an assignee field in Launch settings', async () => {
  seams.edit = true;
  seams.detail.mockResolvedValue(detail('SYNTHETIC_OPTIONAL_ASSIGNEE_URL'));
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_OPTIONAL_ASSIGNEE_URL');
  expect(screen.queryByRole('button', { name: 'Assignee Assignee' })).toBeNull();
});

it('shows historical results to a viewer without offering configuration restore', async () => {
  seams.detail.mockResolvedValue(detail('SYNTHETIC_VIEWER_HISTORY_URL'));
  seams.history.mockResolvedValue([
    {
      id: 'old-revision',
      revisionNo: 1,
      createdAt: '2026-10-13T10:00:00Z',
      kind: 'generated',
      state: 'succeeded'
    }
  ]);
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_VIEWER_HISTORY_URL');
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  await screen.findByText('Ready');
  expect(screen.queryByRole('button', { name: 'Restore configuration' })).toBeNull();
});

it('locks historical restore while a generation is unsettled', async () => {
  seams.edit = true;
  seams.detail.mockResolvedValue({
    ...detail('SYNTHETIC_LOCKED_HISTORY_URL'),
    generation: {
      id: 'generation',
      state: 'running',
      stage: 'catalog_creating',
      stateVersion: '1',
      progress: null,
      errorCode: null,
      childOperationIds: []
    }
  });
  seams.history.mockResolvedValue([
    {
      id: 'old-revision',
      revisionNo: 1,
      createdAt: '2026-10-13T10:00:00Z',
      kind: 'generated',
      state: 'succeeded'
    }
  ]);
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_LOCKED_HISTORY_URL');
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  const restore = await screen.findByRole('button', { name: 'Restore configuration' });
  expect((restore as HTMLButtonElement).disabled).toBe(true);
});

it('stages an old date and budget in the draft while keeping the current result published', async () => {
  seams.selection.mockResolvedValue(null);
  seams.edit = true;
  seams.realGeneration = true;
  const currentConfig = launchConfig({
    originalUrl: 'https://example.invalid/current',
    launchDate: '2026-10-20',
    maxBudget: 40
  });
  const oldConfig = launchConfig({
    originalUrl: 'https://example.invalid/old',
    launchDate: '2025-02-03',
    maxBudget: 90
  });
  const currentPreview = launchPreview(currentConfig, launchSources);
  const oldPreview = launchPreview(oldConfig, launchSources);
  if (!currentPreview.ok || !oldPreview.ok) throw new Error('fixture');
  const activeRevision = {
    id: 'current-revision',
    revisionNo: 2,
    kind: 'generated' as const,
    config: currentConfig,
    sources: launchSources,
    baselineRevisionId: null,
    baseline: currentPreview.value,
    overrides: {},
    catalog: null,
    createdAt: '2026-10-15T00:00:00Z'
  };
  const current: LaunchDetail = {
    ...detail('https://example.invalid/current'),
    workStatus: 'todo',
    draft: currentConfig,
    activeRevision
  };
  const historical: LaunchDetail = {
    ...current,
    activeRevision: {
      ...activeRevision,
      id: 'old-revision',
      revisionNo: 1,
      config: oldConfig,
      baseline: oldPreview.value
    }
  };
  seams.detail
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(historical)
    .mockResolvedValue(current);
  seams.history.mockResolvedValue([
    {
      id: 'old-revision',
      revisionNo: 1,
      createdAt: '2025-02-03T10:00:00Z',
      kind: 'generated',
      state: 'succeeded'
    }
  ]);
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('Date: 2026-10-20');
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Age 50' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  );
  // Exercise the unsaved-decision branch before the genuine 500ms autosave.
  // Wall-clock accessibility queries must not decide whether a draft is dirty.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Restore configuration' }));
  const cancelRestore = screen
    .getAllByRole('button', { name: 'Cancel' })
    .find(button => !(button as HTMLButtonElement).disabled);
  if (!cancelRestore) throw new Error('Missing enabled restore-decision cancel');
  fireEvent.click(cancelRestore);
  expect(screen.getByText('Age: 50')).toBeTruthy();
  expect(screen.getByText('Date: 2026-10-20')).toBeTruthy();
  expect(seams.detail).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Restore configuration' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Discard and restore' }));
  });
  expect(screen.getByText('Date: 2025-02-03')).toBeTruthy();
  expect(screen.getByText('Max budget: 90')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Generate launch' }));
  });
  expect(screen.getByText('Check the value')).toBeTruthy();
  expect(seams.save).not.toHaveBeenCalled();
  expect(seams.generate).not.toHaveBeenCalled();
  vi.useRealTimers();
  view.rerender(<LaunchSpace teamId={TEAM} query={{ ...query, launchTab: 'result' }} />);
  expect(await screen.findByText(currentPreview.value.advertisingUrl)).toBeTruthy();
});

it('keeps the current result when a restored historical material is unavailable', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.edit = true;
  seams.realGeneration = true;
  const currentConfig = launchConfig({ originalUrl: 'https://example.invalid/current' });
  const oldConfig = launchConfig({
    originalUrl: 'https://example.invalid/old',
    materialId: '79999999-0000-4000-8000-000000000099'
  });
  const currentPreview = launchPreview(currentConfig, launchSources);
  const oldPreview = launchPreview(oldConfig, launchSources);
  if (!currentPreview.ok || !oldPreview.ok) throw new Error('fixture');
  const activeRevision = {
    id: 'current-revision',
    revisionNo: 2,
    kind: 'generated' as const,
    config: currentConfig,
    sources: launchSources,
    baselineRevisionId: null,
    baseline: currentPreview.value,
    overrides: {},
    catalog: null,
    createdAt: '2026-10-15T00:00:00Z'
  };
  const current: LaunchDetail = {
    ...detail(currentConfig.originalUrl),
    workStatus: 'todo',
    draft: currentConfig,
    activeRevision
  };
  const historical: LaunchDetail = {
    ...current,
    activeRevision: {
      ...activeRevision,
      id: 'old-revision',
      revisionNo: 1,
      config: oldConfig,
      baseline: oldPreview.value
    }
  };
  seams.detail.mockImplementation(async (_team: string, _launch: string, revisionId?: string) =>
    revisionId === 'old-revision' ? historical : current
  );
  seams.history.mockResolvedValue([
    {
      id: 'old-revision',
      revisionNo: 1,
      createdAt: '2025-02-03T10:00:00Z',
      kind: 'generated',
      state: 'succeeded'
    }
  ]);
  seams.selection.mockImplementation(async (_team: string, config: typeof currentConfig) => {
    if (config.materialId === oldConfig.materialId) throw new TeamApiError('NOT_FOUND', false);
    return launchSources;
  });
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('Date: 2026-10-13');
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  await waitFor(() => expect(seams.selection).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: 'Restore configuration' }));
  expect(screen.queryByRole('button', { name: 'Discard and restore' })).toBeNull();
  await waitFor(() =>
    expect(seams.selection).toHaveBeenCalledWith(
      TEAM,
      expect.objectContaining({ materialId: oldConfig.materialId })
    )
  );
  fireEvent.click(screen.getByRole('button', { name: 'Generate launch' }));
  expect(seams.generate).not.toHaveBeenCalled();
  view.rerender(<LaunchSpace teamId={TEAM} query={{ ...query, launchTab: 'result' }} />);
  expect(await screen.findByText(currentPreview.value.advertisingUrl)).toBeTruthy();
});

it('keeps unsaved edits and the current result when save before historical restore conflicts', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.edit = true;
  const currentConfig = launchConfig({ launchDate: '2026-10-20', maxBudget: 40 });
  const currentPreview = launchPreview(currentConfig, launchSources);
  if (!currentPreview.ok) throw new Error('fixture');
  const current: LaunchDetail = {
    ...detail('https://example.invalid/current'),
    workStatus: 'todo',
    draft: currentConfig,
    activeRevision: {
      id: 'current-revision',
      revisionNo: 2,
      kind: 'generated',
      config: currentConfig,
      sources: launchSources,
      baselineRevisionId: null,
      baseline: currentPreview.value,
      overrides: {},
      catalog: null,
      createdAt: '2026-10-15T00:00:00Z'
    }
  };
  seams.detail.mockResolvedValue(current);
  seams.history.mockResolvedValue([
    {
      id: 'old-revision',
      revisionNo: 1,
      createdAt: '2025-02-03T10:00:00Z',
      kind: 'generated',
      state: 'succeeded'
    }
  ]);
  seams.saveWorkingCopy.mockRejectedValue(new TeamApiError('LAUNCH_VERSION_CONFLICT', false));
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('Age: 45');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Age 50' })).toHaveProperty('disabled', false)
  );
  // This case exercises the unsaved decision before the real 500ms autosave.
  // Coverage/accessibility-query wall time must not choose a different branch.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Restore configuration' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save and restore' }));
  });
  expect(seams.save).not.toHaveBeenCalled();
  expect(screen.getByText('This launch changed in another session')).toBeTruthy();
  expect(screen.getByText('Age: 50')).toBeTruthy();
  expect(screen.getByText('Date: 2026-10-20')).toBeTruthy();
  expect(seams.saveWorkingCopy).toHaveBeenCalledOnce();
  expect(seams.detail).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  view.rerender(<LaunchSpace teamId={TEAM} query={{ ...query, launchTab: 'result' }} />);
  expect(await screen.findByText(currentPreview.value.advertisingUrl)).toBeTruthy();
});

it('acknowledges a saved working copy when the historical read fails afterward', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.edit = true;
  const current = detail('https://example.invalid/current');
  const saved = { ...current, version: '2', draft: { ...current.draft, age: 50 } };
  seams.detail
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(saved)
    .mockRejectedValueOnce(new TeamApiError('NOT_FOUND', false));
  seams.history.mockResolvedValue([
    {
      id: 'old-revision',
      revisionNo: 1,
      createdAt: '2025-02-03T10:00:00Z',
      kind: 'generated',
      state: 'succeeded'
    }
  ]);
  seams.saveWorkingCopy.mockResolvedValue({ id: LAUNCH, version: '2' });
  seams.save.mockResolvedValue({ id: LAUNCH, version: '3' });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('Age: 45');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Age 50' })).toHaveProperty('disabled', false)
  );
  // This case exercises the unsaved decision before the real 500ms autosave.
  // Coverage/accessibility-query wall time must not choose a different branch.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Restore configuration' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save and restore' }));
  });
  expect(seams.save).not.toHaveBeenCalled();
  expect(seams.detail).toHaveBeenCalledTimes(3);
  expect(screen.getByText('Age: 50')).toBeTruthy();
  expect(seams.saveWorkingCopy).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Save and restore' })).toBeNull();
  vi.useRealTimers();
});

it('keeps unsaved settings when another tab publishes a workspace revision', async () => {
  seams.edit = true;
  const original = detail('SYNTHETIC_TWO_TAB_URL');
  seams.detail.mockResolvedValueOnce(original).mockResolvedValue({
    ...original,
    version: '2',
    draft: { ...original.draft, age: 40 }
  });
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('Age: 45');
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  expect(screen.getByText('Age: 50')).toBeTruthy();
  seams.revision++;
  view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Age: 50')).toBeTruthy();
  clickLaunchClose();
  await waitFor(() => expect(seams.saveWorkingCopy).toHaveBeenCalledOnce());
  expect(seams.saveWorkingCopy.mock.calls[0][0].version).toBe('1');
  expect(seams.saveWorkingCopy.mock.calls[0][0].config.age).toBe(50);
});

it('keeps protected draft URL in memory and does not persist it in browser storage', async () => {
  const secret = 'SYNTHETIC_RAM_ONLY_CAPI_SECRET';
  const indexedOpen = vi.fn(() => {
    throw new Error('Launch detail attempted to open IndexedDB');
  });
  const cacheOpen = vi.fn(() => {
    throw new Error('Launch detail attempted to open Cache API');
  });
  vi.stubGlobal('indexedDB', { open: indexedOpen });
  vi.stubGlobal('caches', { open: cacheOpen });
  seams.edit = true;
  seams.detail.mockResolvedValue(detail(`https://example.invalid/?token=${secret}`));
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText(`https://example.invalid/?token=${secret}`);
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const values = Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index);
      return key === null ? '' : `${key}:${storage.getItem(key)}`;
    });
    expect(values.join('\n')).not.toContain(secret);
  }
  expect(indexedOpen).not.toHaveBeenCalled();
  expect(cacheOpen).not.toHaveBeenCalled();
  seams.view = false;
  view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
  expect(document.body.textContent).not.toContain(secret);
});

it('requires reviewing newer defaults and preserves the Launch draft before another save', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.edit = true;
  seams.manage = true;
  seams.detail.mockResolvedValue(detail('SYNTHETIC_OWN_DRAFT'));
  seams.defaults.mockResolvedValueOnce(null).mockResolvedValue({
    config: launchConfig({ campaignCount: 5 }),
    subConfig: launchConfig().subConfig,
    version: '9'
  });
  seams.setDefaults
    .mockRejectedValueOnce(new TeamApiError('LAUNCH_VERSION_CONFLICT', false))
    .mockResolvedValueOnce({ version: '10' });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('SYNTHETIC_OWN_DRAFT');
  expect(
    screen.getByRole('button', { name: 'Save as general defaults' }).getAttribute('title')
  ).toBe(
    'For new launches in this workspace when the offer has no saved settings. Other offer profiles stay unchanged.'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save as general defaults' }));
  await screen.findByRole('button', { name: 'Review current defaults' });
  expect(
    (screen.getByRole('button', { name: 'Save as general defaults' }) as HTMLButtonElement).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Review current defaults' }));
  await screen.findByText('Workspace defaults changed');
  expect(screen.getByText('SYNTHETIC_OWN_DRAFT')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reviewed; keep my Launch draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save as general defaults' }));
  await waitFor(() => expect(seams.setDefaults).toHaveBeenCalledTimes(2));
  expect(seams.setDefaults.mock.calls[1][1]).toBe('9');
  expect(seams.setDefaults.mock.calls[1][3].originalUrl).toBe('SYNTHETIC_OWN_DRAFT');
  expect(seams.setDefaults.mock.calls[1][2]).not.toBe(seams.setDefaults.mock.calls[0][2]);
});

it('keeps an existing draft unchanged when workspace defaults are refreshed', async () => {
  seams.edit = true;
  const existing = detail('SYNTHETIC_EXISTING_DRAFT');
  seams.detail.mockResolvedValue(existing);
  seams.defaults.mockResolvedValueOnce(null).mockResolvedValue({
    config: launchConfig({ age: 60, maxBudget: 90 }),
    subConfig: launchConfig().subConfig,
    version: '2'
  });
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('Age: 45');
  seams.revision++;
  view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
  await waitFor(() =>
    expect(seams.defaults.mock.calls.filter(args => args.length === 1)).toHaveLength(2)
  );
  expect(screen.getByText('Age: 45')).toBeTruthy();
  expect(screen.getByText('Max budget: 30')).toBeTruthy();
  expect(seams.save).not.toHaveBeenCalled();
});

it('keeps a conflicting local configuration until the user explicitly rebases it on a protected current read', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.edit = true;
  const old = detail('SYNTHETIC_CONFLICT_URL');
  const newer = { ...old, version: '2', draft: { ...old.draft, age: 40 } };
  seams.detail.mockResolvedValueOnce(old).mockResolvedValue(newer);
  seams.saveWorkingCopy
    .mockRejectedValueOnce(new TeamApiError('LAUNCH_VERSION_CONFLICT', false))
    .mockResolvedValueOnce({ id: LAUNCH, version: '3' });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('Age: 45');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Age 50' })).toHaveProperty('disabled', false)
  );
  // Keep this conflict/rebase decision ahead of the real autosave debounce.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  await act(async () => clickLaunchClose());
  expect(screen.getByText('This launch changed in another session')).toBeTruthy();
  expect(screen.getByText('Age: 50')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
  });
  expect(screen.getByRole('button', { name: 'Keep my changes against this version' })).toBeTruthy();
  expect(screen.getByText('Age: 50')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Keep my changes against this version' }));
  });
  expect(screen.getByText('Age: 50')).toBeTruthy();
  await act(async () => clickLaunchClose());
  expect(seams.saveWorkingCopy).toHaveBeenCalledTimes(2);
  expect(seams.saveWorkingCopy.mock.calls[1][0].version).toBe('2');
  expect(seams.saveWorkingCopy.mock.calls[1][0].config.age).toBe(50);
  expect(seams.saveWorkingCopy.mock.calls[1][0].requestKey).not.toBe(
    seams.saveWorkingCopy.mock.calls[0][0].requestKey
  );
});

it('saves a new Launch draft through the close action', async () => {
  const { useBrowserRoute } = await import('../apps/web/src/lib/navigation');
  const { buildTeamRoute, parseTeamRoute } = await import('../apps/web/src/team/routes');
  seams.edit = true;
  const path = buildTeamRoute({
    spaceId: TEAM,
    section: 'launches',
    query: {
      ...query,
      launchId: 'new',
      launchTab: 'settings'
    }
  });
  window.history.replaceState({}, '', path);
  let current: LaunchDetail | null = null;
  seams.save.mockImplementationOnce(async (input: { config: LaunchDetail['draft'] }) => {
    current = {
      id: LAUNCH,
      version: '1',
      draft: input.config,
      expectedSourceSnapshot: null,
      assigneeId: null,
      workStatus: 'todo',
      activeRevision: null,
      generation: null
    };
    return { id: LAUNCH, version: '1' };
  });
  seams.detail.mockImplementation(async () => current);
  function Host() {
    const parsed = parseTeamRoute(useBrowserRoute());
    return parsed?.kind === 'space' ? <LaunchSpace teamId={TEAM} query={parsed.query} /> : null;
  }
  render(<Host />);
  await screen.findByRole('button', { name: 'Age 50' });
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  clickLaunchClose();
  await waitFor(() => expect(seams.save).toHaveBeenCalledOnce());
  await waitFor(() => expect(window.location.search).not.toContain('launch=new'));
  expect(seams.save.mock.calls[0][0].config.age).toBe(50);
  expect(seams.editorMounts).toBe(1);
  expect(screen.queryByRole('dialog', { name: 'Launches' })).toBeNull();
});

it('autosaves settings without disabling typing and restores the confirmed draft after remount', async () => {
  seams.edit = true;
  seams.selection.mockResolvedValue(launchSources);
  const original = detail('https://example.invalid/?token=AUTOSAVE_FIXTURE');
  seams.accounts = [
    {
      id: launchSources.accountId,
      name: launchSources.social,
      agents: [{ id: original.draft.agentRowId, agentId: launchSources.agentId }]
    }
  ];
  seams.offers = [{ id: original.draft.offerId, value: launchSources.offer }];
  seams.buyers = [{ id: original.draft.buyerId, value: launchSources.buyer }];
  seams.detail.mockResolvedValue(original);
  let resolveFirst!: (result: { id: string; version: string }) => void;
  seams.save.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveFirst = resolve;
      })
  );
  seams.save.mockResolvedValue({ id: LAUNCH, version: '3' });
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByRole('button', { name: 'Age 50' });
  await waitFor(() => expect(screen.queryByText('Loading default settings…')).toBeNull());
  const statusRow = document.querySelector('.launch-draft-save-status')!;
  const detailChildren = document.querySelector('.launch-detail')!.children.length;
  const actionChildren = document.querySelector('.launch-detail-actions')!.children.length;
  fireEvent.click(screen.getByRole('button', { name: 'Age 50' }));
  expect(statusRow.textContent).toBe('Saving changes…');
  expect(document.querySelector('.launch-detail')!.children.length).toBe(detailChildren);
  expect(document.querySelector('.launch-detail-actions')!.children.length).toBe(actionChildren);
  expect(screen.queryByText('Wait for changes to save before copying this launch.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy launch' })).toHaveProperty('disabled', true);
  await waitFor(() => expect(seams.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
  const generateButton = screen.getByRole('button', { name: 'Generate launch' });
  expect(statusRow.querySelector('.ui-spinner')).not.toBeNull();
  expect((generateButton as HTMLButtonElement).disabled).toBe(true);
  expect(
    document.getElementById(generateButton.getAttribute('aria-describedby')!)?.textContent
  ).toBe('Saving changes…');
  expect(document.querySelector('.launch-draft-save-status')).toBe(statusRow);
  expect(generateButton.classList.contains('is-loading')).toBe(false);
  expect(
    (screen.getByRole('button', { name: 'Synthetic URL' }) as HTMLButtonElement).disabled
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Synthetic URL' }));
  await act(async () => resolveFirst({ id: LAUNCH, version: '2' }));
  await waitFor(() => expect(seams.save).toHaveBeenCalledTimes(2), { timeout: 5000 });
  const confirmed = seams.save.mock.calls[1][0];
  expect(confirmed).toMatchObject({
    version: '2',
    config: { age: 50, originalUrl: 'https://example.invalid/?capi=SYNTHETIC_CANCEL_URL' }
  });
  await screen.findByText('Launch draft saved');
  expect(document.querySelector('.launch-draft-save-status')).toBe(statusRow);
  expect(document.querySelector('.launch-detail')!.children.length).toBe(detailChildren);
  expect(document.querySelector('.launch-detail-actions')!.children.length).toBe(actionChildren);
  expect(screen.getByRole('button', { name: 'Copy launch' })).toHaveProperty('disabled', false);
  expect(generateButton.hasAttribute('aria-busy')).toBe(false);
  expect(generateButton.hasAttribute('aria-describedby')).toBe(false);
  expect((generateButton as HTMLButtonElement).disabled).toBe(false);
  view.unmount();
  seams.detail.mockResolvedValue({ ...original, version: '3', draft: confirmed.config });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  expect(await screen.findByText('Age: 50')).toBeTruthy();
  expect(screen.getByText('https://example.invalid/?capi=SYNTHETIC_CANCEL_URL')).toBeTruthy();
  expect(JSON.stringify(Object.entries(localStorage))).not.toContain('SYNTHETIC_CANCEL_URL');
  expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain('SYNTHETIC_CANCEL_URL');
});

it('routes a missing-image recovery directly to restitch settings while retaining the Launch', async () => {
  seams.edit = true;
  seams.detail.mockResolvedValue({
    ...detail('SYNTHETIC_IMAGE_RECOVERY'),
    generation: {
      id: 'failed-images',
      state: 'failed',
      stage: 'restitch_preparing',
      errorCode: 'RESTITCH_POOL_EMPTY'
    }
  });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose re-stitching images' }));
  const params = new URLSearchParams(window.location.search);
  expect(params.get('settings')).toBe('1');
  expect(params.get('tab')).toBe('restitch');
  expect(params.get('launch')).toBe(LAUNCH);
  expect(params.get('launchTab')).toBe('settings');
  expect(seams.generate).not.toHaveBeenCalled();
});

it('does not replace current generation state with an older workspace snapshot', async () => {
  const current = {
    ...detail('https://example.invalid/current-snapshot'),
    generation: {
      id: 'generation',
      state: 'running',
      stage: 'catalog_sharing',
      stateVersion: '8',
      progress: null,
      errorCode: null,
      childOperationIds: []
    }
  };
  seams.detail.mockResolvedValue(current);
  const view = render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByText('https://example.invalid/current-snapshot');
  seams.detail.mockResolvedValue({
    ...current,
    draft: { ...current.draft, originalUrl: 'https://example.invalid/stale-snapshot' },
    generation: { ...current.generation, stage: 'catalog_creating', stateVersion: '7' }
  });
  seams.revision++;
  view.rerender(<LaunchSpace teamId={TEAM} query={query} />);
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
  expect(screen.getByText('https://example.invalid/current-snapshot')).toBeTruthy();
  expect(screen.queryByText('https://example.invalid/stale-snapshot')).toBeNull();
});

function listLaunch(id = LAUNCH) {
  return {
    id,
    version: '4',
    launchDate: null,
    offer: `Offer ${id}`,
    social: 'g1',
    creativeAlias: 'v5',
    method: 'other' as const,
    workStatus: 'todo' as const,
    assigneeId: null,
    budgets: [],
    generationState: null
  };
}
it('copies selected list links and deletes the exact selection with the chosen retention preference', async () => {
  seams.delete = true;
  const second = '79999999-0000-4000-8000-000000000003';
  seams.list.mockResolvedValue({ items: [listLaunch(), listLaunch(second)], nextCursor: null });
  seams.archiveWarning.mockResolvedValue({
    hasCatalog: true,
    hasRestitch: true,
    suppressed: false
  });
  seams.archive.mockResolvedValue(undefined);
  const writeText = vi.fn().mockResolvedValue(undefined);
  mockClipboard(writeText);
  render(<LaunchSpace teamId={TEAM} query={emptyTeamRouteQuery()} />);
  await screen.findAllByRole('checkbox', { name: 'Select launch' });
  for (const checkbox of screen.getAllByRole('checkbox', { name: 'Select launch' }))
    fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('button', { name: 'Do to all' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy launch links' }));
  expect(writeText).toHaveBeenCalledOnce();
  const links = writeText.mock.calls[0][0].split('\n');
  expect(links).toHaveLength(2);
  expect(links[0]).toContain(LAUNCH);
  expect(links[1]).toContain(second);
  fireEvent.click(screen.getByRole('button', { name: 'Do to all' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete selected launches (2)' }));
  await screen.findByText('The catalog and restitched video will remain in the workspace.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Do not show again' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete launch' }));
  await waitFor(() => expect(seams.archive).toHaveBeenCalledTimes(2));
  expect(seams.archive.mock.calls.map(call => [call[0], call[1], call[2], call[4]])).toEqual([
    [TEAM, LAUNCH, '4', true],
    [TEAM, second, '4', true]
  ]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Do to all' })).toBeNull());
  expect(seams.list.mock.calls.length).toBeGreaterThan(1);
});
it('keeps a failed list deletion retry tied to its original request and exposes clipboard errors', async () => {
  seams.delete = true;
  seams.list.mockResolvedValue({ items: [listLaunch()], nextCursor: null });
  seams.archiveWarning.mockResolvedValue({
    hasCatalog: true,
    hasRestitch: false,
    suppressed: false
  });
  seams.archive.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  mockClipboard(vi.fn().mockRejectedValue(new Error('denied')));
  render(<LaunchSpace teamId={TEAM} query={emptyTeamRouteQuery()} />);
  await screen.findByRole('button', { name: 'Launch actions' });
  fireEvent.click(screen.getByRole('button', { name: 'Launch actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link to launch' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Launch actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete launch' }));
  await screen.findByText('The catalog will remain in the workspace.');
  fireEvent.click(screen.getByRole('button', { name: 'Delete launch' }));
  await waitFor(() => expect(seams.archive).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Delete launch' }) as HTMLButtonElement).disabled
    ).toBe(false)
  );
  const first = [...seams.archive.mock.calls[0]];
  fireEvent.click(screen.getByRole('button', { name: 'Delete launch' }));
  await waitFor(() => expect(seams.archive).toHaveBeenCalledTimes(2));
  expect(seams.archive.mock.calls[1]).toEqual(first);
  expect(seams.archiveWarning).toHaveBeenCalledOnce();
});
it('appends a cursor page and clears a filter that has no matching launches', async () => {
  const second = '79999999-0000-4000-8000-000000000003';
  seams.list
    .mockResolvedValueOnce({ items: [listLaunch()], nextCursor: { id: LAUNCH, date: null } })
    .mockResolvedValueOnce({ items: [listLaunch(second)], nextCursor: null })
    .mockResolvedValue({ items: [], nextCursor: null });
  render(<LaunchSpace teamId={TEAM} query={emptyTeamRouteQuery()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
  await waitFor(() => expect(document.querySelectorAll('.launch-card')).toHaveLength(2));
  expect(seams.list).toHaveBeenLastCalledWith(TEAM, {
    search: '',
    cursorId: LAUNCH,
    cursorDate: null
  });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  const clear = await screen.findByRole('button', { name: 'Clear filters' });
  fireEvent.click(clear);
  await waitFor(() => expect(seams.list).toHaveBeenLastCalledWith(TEAM, { search: '' }));
});

it('loads an editor assignee filter without querying private member management data', async () => {
  seams.edit = true;
  seams.members = [{ userId: 'member-b', displayName: 'Editor B' }];
  const management = vi
    .spyOn(teamApi, 'listMembers')
    .mockRejectedValue(new Error('PERMISSION_DENIED'));
  const directory = vi.spyOn(teamApi, 'listAssignees');
  try {
    render(<LaunchSpace teamId={TEAM} query={emptyTeamRouteQuery()} />);
    await waitFor(() => expect(directory).toHaveBeenCalledWith(TEAM));
    expect(management).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }));
    expect(screen.getByRole('option', { name: 'Editor B' })).toBeTruthy();
  } finally {
    management.mockRestore();
    directory.mockRestore();
  }
});

it('saves an offer with its own version, clears the old proposal, and preserves an uncertain request for retry', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.edit = true;
  seams.manage = true;
  const current = detail('SYNTHETIC_OFFER_URL');
  seams.detail.mockResolvedValue(current);
  seams.offers = [{ id: current.draft.offerId, value: 'Offer A', updatedAt: 'now' }];
  seams.defaults.mockImplementation(async (_team, offerId) =>
    offerId
      ? {
          config: launchConfig({ campaignCount: 8 }),
          subConfig: launchConfig().subConfig,
          version: '17'
        }
      : null
  );
  seams.setDefaults
    .mockRejectedValueOnce(new TeamApiError('INVALID_RESPONSE', true))
    .mockResolvedValueOnce({ version: '18' });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByRole('button', { name: 'Apply offer settings' });
  const save = screen.getByRole('button', { name: 'Save for offer' });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() => expect(seams.setDefaults).toHaveBeenCalledOnce());
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  expect(
    (screen.getByRole('button', { name: 'Save as general defaults' }) as HTMLButtonElement).disabled
  ).toBe(true);
  expect((screen.getByRole('button', { name: 'Age 50' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(save);
  await screen.findByText('Offer settings saved');
  expect(seams.setDefaults.mock.calls[1]).toEqual(seams.setDefaults.mock.calls[0]);
  expect(seams.setDefaults.mock.calls[0][1]).toBe('17');
  expect(seams.setDefaults.mock.calls[0][4]).toBe(current.draft.offerId);
  expect(screen.queryByRole('button', { name: 'Apply offer settings' })).toBeNull();
});

it('reviews a conflict in the selected offer rather than the workspace profile', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  seams.edit = true;
  seams.manage = true;
  const current = detail('SYNTHETIC_OFFER_CONFLICT');
  seams.detail.mockResolvedValue(current);
  seams.offers = [{ id: current.draft.offerId, value: 'Offer A', updatedAt: 'now' }];
  seams.defaults.mockImplementation(async (_team, offerId) =>
    offerId
      ? {
          config: launchConfig({ minBudget: 10, budgetMode: 'manual', budgets: [10, 25, 30] }),
          subConfig: launchConfig().subConfig,
          version: '17'
        }
      : null
  );
  seams.setDefaults
    .mockRejectedValueOnce(new TeamApiError('LAUNCH_VERSION_CONFLICT', false))
    .mockResolvedValueOnce({ version: '18' });
  render(<LaunchSpace teamId={TEAM} query={query} />);
  await screen.findByRole('button', { name: 'Apply offer settings' });
  const save = screen.getByRole('button', { name: 'Save for offer' });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  fireEvent.click(await screen.findByRole('button', { name: 'Review current defaults' }));
  await screen.findByText('Settings changed for offer “Offer A”');
  expect(screen.getByText('10 · 25 · 30')).toBeTruthy();
  expect(seams.defaults).toHaveBeenLastCalledWith(TEAM, current.draft.offerId);
  fireEvent.click(screen.getByRole('button', { name: 'Reviewed; keep my Launch draft' }));
  fireEvent.click(save);
  await screen.findByText('Offer settings saved');
  expect(seams.setDefaults.mock.calls[1][1]).toBe('17');
  expect(seams.setDefaults.mock.calls[1][4]).toBe(current.draft.offerId);
  expect(screen.getByText('Age: 45')).toBeTruthy();
});

it('initializes a new launch from a legacy general budget without inventing a minimum', async () => {
  seams.edit = true;
  seams.manage = true;
  seams.defaults.mockResolvedValue({
    config: { campaignCount: 3, maxBudget: 6 },
    subConfig: launchConfig().subConfig,
    version: '2'
  });
  seams.setDefaults.mockResolvedValue({ version: '3' });
  render(<LaunchSpace teamId={TEAM} query={{ ...query, launchId: 'new' }} />);
  await screen.findByText('Max budget: 6');
  fireEvent.click(screen.getByRole('button', { name: 'Save as general defaults' }));
  await screen.findByText('General settings saved');
  expect(seams.setDefaults.mock.calls[0][3].minBudget).toBeUndefined();
  expect(seams.setDefaults.mock.calls[0][3].campaignCount).toBe(3);
  expect(
    (screen.getByRole('button', { name: 'Save for offer' }) as HTMLButtonElement).disabled
  ).toBe(true);
});
