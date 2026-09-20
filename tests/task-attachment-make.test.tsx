// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamApi } from '../apps/web/src/api/team';
import type { ActionContext, MaterialRef } from '../apps/web/src/team/materials/actions';
import { resolveMaterialActions } from '../apps/web/src/team/materials/useMaterialActionList';
import { attachResultToTask } from '../apps/web/src/team/explorer/useAgentQueue';
import { compressJobs } from '../apps/web/src/team/explorer/TeamCompressorDialog';
import { spaceRouteFor } from '../apps/web/src/team/SpaceSettingsLink';
import { buildTeamRoute, parseTeamRoute } from '../apps/web/src/team/routes';
import { onTaskAttachmentsChanged } from '../apps/web/src/team/tasks/taskAttachmentEvents';

/**
 * T158 — the performer's loop closes inside the task (024, US10).
 *
 * The owner's example had a first half — make the catalog from the task — and
 * a second half nobody had written: transcribe it and compress it from there
 * too, and have what comes out land back on the task without going to find it.
 */

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const video: MaterialRef = {
  id: 'm1',
  teamId: 't1',
  name: 'clip.mp4',
  kind: 'file',
  category: 'video',
  availability: 'ready'
};

const taskContext: ActionContext = {
  host: 'task-attachment',
  permissions: {
    view: true,
    download: true,
    upload: true,
    edit: true,
    delete: true,
    process: true,
    manage_members: true,
    manage_metadata: true
  },
  isOwner: true,
  agentConnected: true,
  storageConnected: true,
  restitchConfigured: true,
  catalogSettingsReady: true
} as ActionContext;

const noop = () => undefined;

describe('a video on a task', () => {
  it('offers everything "Make" can do, and keeps the card to two inline actions', () => {
    const list = resolveMaterialActions(
      video,
      taskContext,
      {
        open: noop,
        productCatalog: noop,
        transcribe: noop,
        compress: noop,
        process: noop,
        copyLink: noop,
        showInFolder: noop,
        detach: noop
      },
      { maxInline: 2 }
    );
    const make = list.groups.find(group => group.group === 'make');
    expect(make?.actions.map(entry => entry.action.id)).toEqual([
      'productCatalog',
      'transcribe',
      'compress',
      'process'
    ]);
    expect(list.inline.map(entry => entry.action.id)).toEqual(['open', 'productCatalog']);
  });

  it('compresses into jobs that carry the task their result belongs on', () => {
    const [job] = compressJobs(
      {
        items: [{ id: 'm1', name: 'clip.mp4', folderId: 'f1' }],
        embed: false,
        suffix: '',
        destination: { kind: 'beside' }
      },
      { taskId: 'task-1' }
    );
    expect(job).toMatchObject({
      tool: 'compressor',
      outputName: 'clip_1.mp4',
      attachTo: { taskId: 'task-1' }
    });
    const [plain] = compressJobs({
      items: [{ id: 'm1', name: 'clip.mp4', folderId: 'f1' }],
      embed: false,
      suffix: '',
      destination: { kind: 'beside' }
    });
    expect(plain).not.toHaveProperty('attachTo');
  });
});

describe('what a run made, put on the task', () => {
  const t = ((key: string, values?: Record<string, unknown>) =>
    `${key}${values?.name ? `:${values.name}` : ''}`) as never;

  it('attaches, tells the editor, and offers to take it off', async () => {
    vi.spyOn(teamApi, 'attachTaskMaterials').mockResolvedValue({
      attached: ['out-1'],
      alreadyAttached: [],
      rejected: []
    } as never);
    const detach = vi.spyOn(teamApi, 'detachTaskMaterial').mockResolvedValue(true);
    const push = vi.fn();
    const heard = vi.fn();
    const stop = onTaskAttachmentsChanged('task-1', heard);

    await attachResultToTask({
      teamId: 't1',
      taskId: 'task-1',
      materialId: 'out-1',
      name: 'clip.txt',
      push,
      t
    });

    expect(heard).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    const toast = push.mock.calls[0]![0] as { text: string; action: { run: () => Promise<void> } };
    expect(toast.text).toBe('teamTaskResultAttached:clip.txt');
    await toast.action.run();
    expect(detach).toHaveBeenCalledWith('t1', 'task-1', 'out-1');
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it('says nothing when it was already there, or the task is gone', async () => {
    const push = vi.fn();
    vi.spyOn(teamApi, 'attachTaskMaterials').mockResolvedValueOnce({
      attached: [],
      alreadyAttached: ['out-1'],
      rejected: []
    } as never);
    await attachResultToTask({
      teamId: 't1',
      taskId: 'task-1',
      materialId: 'out-1',
      name: 'x',
      push,
      t
    });
    vi.spyOn(teamApi, 'attachTaskMaterials').mockRejectedValueOnce(new Error('NOT_FOUND'));
    await attachResultToTask({
      teamId: 't1',
      taskId: 'gone',
      materialId: 'out-1',
      name: 'x',
      push,
      t
    });
    expect(push).not.toHaveBeenCalled();
  });
});

describe('the ways out of a task come back to it', () => {
  it('opens settings over the task that needed them', () => {
    window.history.replaceState(null, '', '/team/space-1/tasks?task=task-1');
    expect(
      parseTeamRoute(spaceRouteFor('space-1', { kind: 'settings', tab: 'restitch' }))
    ).toMatchObject({
      section: 'tasks',
      query: { taskId: 'task-1', settings: true, settingsTab: 'restitch' }
    });
  });

  it('remembers which task sent you to its folder', () => {
    const route = buildTeamRoute({
      spaceId: 'space-1',
      section: 'explorer',
      query: { folderId: 'f1', itemId: 'm1', back: 'task-1' }
    });
    expect(route).toBe('/team/space-1?folder=f1&item=m1&back=task-1');
    expect(parseTeamRoute(route)).toMatchObject({ query: { back: 'task-1' } });
    // A Tasks address has no folder to return from.
    expect(
      buildTeamRoute({ spaceId: 'space-1', section: 'tasks', query: { back: 'task-1' } })
    ).toBe('/team/space-1/tasks');
  });
});
