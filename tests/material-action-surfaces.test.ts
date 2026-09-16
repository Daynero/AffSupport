import { describe, expect, it } from 'vitest';
import {
  MATERIAL_ACTIONS,
  type ActionContext,
  type ActionHost,
  type MaterialActionId,
  type MaterialRef
} from '../apps/web/src/team/materials/actions';
import {
  resolveMaterialActions,
  type ActionHandlers
} from '../apps/web/src/team/materials/useMaterialActionList';

/**
 * SC-003: the same file offers the same things wherever you meet it.
 *
 * This is the promise the whole feature rests on, and the one that was most
 * comprehensively broken: a video in a folder offered eleven actions, the same
 * video in a search result offered five different ones, and the same video on a
 * task offered six unlabelled icons and could not be catalogued at all.
 *
 * Checked here rather than by opening five screens, because that is exactly the
 * comparison nobody makes twice.
 */

const HOSTS: ActionHost[] = [
  'explorer-row',
  'explorer-tile',
  'explorer-detail',
  'search-result',
  'task-attachment',
  'updater-row'
];

/** A host that has wired everything up: the resolver drops what it cannot run. */
function everyHandler(): ActionHandlers {
  return Object.fromEntries(
    MATERIAL_ACTIONS.map(action => [action.id, () => undefined])
  ) as ActionHandlers;
}

const permissions = {
  view: true,
  download: true,
  upload: true,
  edit: true,
  delete: true,
  process: true,
  manage_members: true,
  manage_metadata: true
};

function context(host: ActionHost, over: Partial<ActionContext> = {}): ActionContext {
  return {
    host,
    permissions,
    isOwner: true,
    agentConnected: true,
    storageConnected: true,
    restitchConfigured: true,
    catalogSettingsReady: true,
    ...over
  };
}

const video: MaterialRef = {
  id: 'm1',
  teamId: 't1',
  name: 'clip.mp4',
  kind: 'file',
  category: 'video',
  availability: 'ready'
};

function shapeOf(host: ActionHost) {
  const list = resolveMaterialActions(video, context(host), everyHandler());
  const shape = new Map<MaterialActionId, { group: string; order: number; label: string }>();
  for (const group of list.groups) {
    for (const entry of group.actions) {
      shape.set(entry.action.id, {
        group: group.group,
        order: entry.action.order,
        label: entry.action.labelKey
      });
    }
  }
  return shape;
}

describe('one material, every surface', () => {
  it('describes a shared action identically on every surface that offers it', () => {
    const shapes = new Map(HOSTS.map(host => [host, shapeOf(host)]));
    const reference = shapes.get('explorer-row');
    if (!reference) throw new Error('no reference surface');

    for (const [host, shape] of shapes) {
      for (const [id, described] of shape) {
        const elsewhere = reference.get(id);
        if (!elsewhere) continue;
        expect(described, `${id} on ${host}`).toEqual(elsewhere);
      }
    }
  });

  it('draws the groups in one order, always', () => {
    for (const host of HOSTS) {
      const order = resolveMaterialActions(video, context(host), everyHandler()).groups.map(
        group => group.group
      );
      const expected = ['open', 'get', 'make', 'organise', 'remove'].filter(group =>
        order.includes(group as never)
      );
      expect(order, host).toEqual(expected);
    }
  });

  it('puts the destructive group last on every surface that has one', () => {
    for (const host of HOSTS) {
      const groups = resolveMaterialActions(video, context(host), everyHandler()).groups;
      const remove = groups.findIndex(group => group.group === 'remove');
      if (remove === -1) continue;
      expect(remove, host).toBe(groups.length - 1);
    }
  });

  it('renders no more than four actions without a menu', () => {
    for (const host of HOSTS) {
      const list = resolveMaterialActions(video, context(host), everyHandler());
      expect(list.inline.length, host).toBeLessThanOrEqual(4);
    }
  });

  it('never puts an action it cannot run inline', () => {
    const offline = context('explorer-row', { agentConnected: false });
    const list = resolveMaterialActions(video, offline, everyHandler());
    for (const entry of list.inline) expect(entry.availability.ok).toBe(true);
  });
});

describe('the owner’s example', () => {
  const taskHost = context('task-attachment');

  it('offers the product catalog on a video attached to a task', () => {
    const list = resolveMaterialActions(video, taskHost, everyHandler());
    const ids = list.groups.flatMap(group => group.actions.map(entry => entry.action.id));
    expect(ids).toContain('productCatalog');
  });

  it('offers it without opening a menu', () => {
    // Behind a menu it is still two presses further away than it should be.
    const list = resolveMaterialActions(video, taskHost, everyHandler());
    expect(list.inline.map(entry => entry.action.id)).toContain('productCatalog');
  });

  it('keeps it out of the way on anything that cannot have one', () => {
    const folder: MaterialRef = { ...video, kind: 'folder', category: null };
    const list = resolveMaterialActions(folder, taskHost, everyHandler());
    const ids = list.groups.flatMap(group => group.actions.map(entry => entry.action.id));
    expect(ids).not.toContain('productCatalog');
  });

  it('keeps it visible, with a reason, when the Drive is not connected', () => {
    const list = resolveMaterialActions(
      video,
      context('task-attachment', { storageConnected: false }),
      everyHandler()
    );
    const make = list.groups.find(group => group.group === 'make');
    const catalog = make?.actions.find(entry => entry.action.id === 'productCatalog');
    expect(catalog).toBeDefined();
    expect(catalog?.availability).toEqual({ ok: false, reason: 'STORAGE_DISCONNECTED' });
    // …and it does not take one of the four inline places while it cannot run.
    expect(list.inline.map(entry => entry.action.id)).not.toContain('productCatalog');
  });
});

/**
 * T059 — a file is not alone, and every surface should say so.
 *
 * The transcript and the catalog are companion materials, and before this each
 * was readable only from the one panel that made it. These hold the two rules
 * the registry enforces once the companions are supplied: the text is offered
 * only when there is text, and an existing catalog is openable even where a
 * new one could not be made.
 */
describe('companions', () => {
  it('offers the text only when a transcript exists', () => {
    const alone = resolveMaterialActions(video, context('explorer-detail'), everyHandler());
    expect(alone.groups.flatMap(g => g.actions.map(e => e.action.id))).not.toContain('copyText');

    const withText: MaterialRef = {
      ...video,
      companions: { transcript: { ready: true } }
    };
    const list = resolveMaterialActions(withText, context('explorer-detail'), everyHandler());
    const entry = list.groups
      .flatMap(group => group.actions)
      .find(action => action.action.id === 'copyText');
    expect(entry?.availability).toEqual({ ok: true });
  });

  it('says the text is not ready rather than hiding it mid-transcription', () => {
    const pending: MaterialRef = {
      ...video,
      companions: { transcript: { ready: false } }
    };
    const list = resolveMaterialActions(pending, context('explorer-detail'), everyHandler());
    const entry = list.groups
      .flatMap(group => group.actions)
      .find(action => action.action.id === 'copyText');
    expect(entry?.availability).toEqual({ ok: false, reason: 'NOT_READY' });
  });

  it('opens a catalog that exists even where a new one could not be made', () => {
    const hasCatalog: MaterialRef = {
      ...video,
      companions: { productCatalog: { link: 'https://docs.google.com/x', productCount: 12 } }
    };
    const list = resolveMaterialActions(
      hasCatalog,
      context('explorer-detail', { catalogSettingsReady: false }),
      everyHandler()
    );
    const entry = list.groups
      .flatMap(group => group.actions)
      .find(action => action.action.id === 'productCatalog');
    expect(entry?.availability).toEqual({ ok: true });
  });
});
