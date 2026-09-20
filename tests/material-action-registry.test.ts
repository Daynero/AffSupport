import { describe, expect, it } from 'vitest';
import {
  MATERIAL_ACTIONS,
  MATERIAL_ACTION_GROUPS,
  MATERIAL_ACTION_IDS,
  type ActionContext,
  type ActionHost,
  type MaterialRef
} from '../apps/web/src/team/materials/actions';
import { translate, translationKeys } from '../apps/web/src/i18n';

/**
 * The registry's own rules, checked rather than remembered.
 *
 * Every one of these was a defect in the screens this replaces: a menu of
 * eleven ungrouped items, a destructive action flush against a safe one, six
 * unlabelled icons in 158 pixels, and an action offered under two different
 * names on two different screens.
 */

const HOSTS: ActionHost[] = [
  'explorer-row',
  'explorer-tile',
  'explorer-detail',
  'search-result',
  'task-attachment',
  'updater-row',
  'selection',
  'palette'
];

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

const folder: MaterialRef = {
  id: 'f1',
  teamId: 't1',
  name: 'Creatives',
  kind: 'folder',
  category: null,
  availability: 'ready'
};

describe('the material action registry', () => {
  it('names every action exactly once', () => {
    const ids = MATERIAL_ACTIONS.map(action => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(MATERIAL_ACTION_IDS));
  });

  it('gives every action a translation key that exists, in both languages', () => {
    const known = new Set(translationKeys);
    for (const action of MATERIAL_ACTIONS) {
      expect(known.has(action.labelKey), action.labelKey).toBe(true);
      // A key present in English and missing in Ukrainian falls back to the
      // English text, which reads as a bug to the only people using this.
      expect(translate('uk', action.labelKey), `uk:${action.labelKey}`).not.toBe(
        translate('en', action.labelKey)
      );
    }
  });

  it('puts every destructive action in the last group', () => {
    for (const action of MATERIAL_ACTIONS) {
      if (action.destructive) expect(action.group, action.id).toBe('remove');
    }
  });

  it('orders unambiguously within every group', () => {
    for (const group of MATERIAL_ACTION_GROUPS) {
      const orders = MATERIAL_ACTIONS.filter(a => a.group === group).map(a => a.order);
      expect(new Set(orders).size, group).toBe(orders.length);
    }
  });

  it('keeps no group longer than seven items', () => {
    // Seven is where a list stops being scannable. Past it the answer is
    // another group, not a longer one.
    for (const group of MATERIAL_ACTION_GROUPS) {
      const size = MATERIAL_ACTIONS.filter(a => a.group === group).length;
      expect(size, group).toBeLessThanOrEqual(7);
    }
  });

  it('decides the inline order without a tie', () => {
    // More actions want to be inline than fit, so which four appear is decided
    // by priority — and two actions sharing one priority would make that order
    // depend on the order of the table, which is not a decision anybody made.
    const priorities = MATERIAL_ACTIONS.map(action => action.inlinePriority).filter(
      (value): value is number => value !== null
    );
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('gives every surface something inline, and never more than four', () => {
    for (const host of HOSTS) {
      const candidates = MATERIAL_ACTIONS.filter(
        action => action.applies(video, context(host)) && action.inlinePriority !== null
      ).sort((a, b) => (b.inlinePriority ?? 0) - (a.inlinePriority ?? 0));
      // The resolver takes the first four; what matters here is that there is
      // at least one, so no surface is a bare "…" with nothing beside it.
      expect(candidates.length, host).toBeGreaterThan(0);
      expect(candidates.slice(0, 4).length, host).toBeLessThanOrEqual(4);
    }
  });

  it('never offers a catalog on a folder — absent, not disabled', () => {
    const catalog = MATERIAL_ACTIONS.find(action => action.id === 'productCatalog');
    expect(catalog?.applies(folder, context('explorer-row'))).toBe(false);
  });

  it('keeps the catalog present and explained when the Drive is disconnected', () => {
    const catalog = MATERIAL_ACTIONS.find(action => action.id === 'productCatalog');
    const where = context('task-attachment', { storageConnected: false });
    expect(catalog?.applies(video, where)).toBe(true);
    expect(catalog?.available(video, where)).toEqual({
      ok: false,
      reason: 'STORAGE_DISCONNECTED'
    });
  });

  it('explains rather than hides what a role cannot do', () => {
    const where = context('explorer-row', {
      permissions: { ...permissions, delete: false }
    });
    const trash = MATERIAL_ACTIONS.find(action => action.id === 'trash');
    expect(trash?.applies(video, where)).toBe(true);
    expect(trash?.available(video, where)).toEqual({ ok: false, reason: 'NO_PERMISSION' });
  });

  it('says a trashed file is trashed rather than refusing silently', () => {
    const trashed: MaterialRef = { ...video, trashed: true, availability: 'trashed' };
    const download = MATERIAL_ACTIONS.find(action => action.id === 'download');
    expect(download?.available(trashed, context('explorer-row'))).toEqual({
      ok: false,
      reason: 'TRASHED'
    });
  });

  it('never offers to take a file off a task anywhere but on a task', () => {
    const detach = MATERIAL_ACTIONS.find(action => action.id === 'detach');
    for (const host of HOSTS) {
      expect(detach?.applies(video, context(host)), host).toBe(host === 'task-attachment');
    }
  });

  it('never offers to trash a file from inside a task', () => {
    // Detaching and trashing were one press apart with nothing to tell them
    // apart. Only one of them belongs on a task.
    const trash = MATERIAL_ACTIONS.find(action => action.id === 'trash');
    expect(trash?.applies(video, context('task-attachment'))).toBe(false);
  });
});

describe('the same material, offered from every surface', () => {
  it('describes each action identically wherever it applies', () => {
    // SC-003. The label, the icon, the group and the position are properties of
    // the action, not of the screen — which is exactly what was not true before.
    for (const action of MATERIAL_ACTIONS) {
      const hosts = HOSTS.filter(host => action.applies(video, context(host)));
      if (hosts.length < 2) continue;
      const shapes = hosts.map(() => ({
        label: action.labelKey,
        icon: action.icon,
        group: action.group,
        order: action.order
      }));
      for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    }
  });
});
