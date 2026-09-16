import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TeamAnalyticsStorage, TeamPermissions } from '@video-compressor/shared';
import { ToastProvider } from '../../apps/web/src/components/toast';
import type { MaterialActionsClient } from '../../apps/web/src/team/catalog/useMaterialActions';
import type { FolderPickerClient } from '../../apps/web/src/team/catalog/FolderPicker';
import type { ActionContext, MaterialRef } from '../../apps/web/src/team/materials/actions';
import { useMaterialActionHost } from '../../apps/web/src/team/materials/MaterialActionHost';
import { MaterialInlineActions } from '../../apps/web/src/team/materials/MaterialInlineActions';
import { useMaterialActionList } from '../../apps/web/src/team/materials/useMaterialActionList';

/**
 * One harness for the surface every material now wears (024).
 *
 * The behaviours below it — trash and its undo, a rename that keeps its
 * extension, permissions that stay independent of one another, one outcome per
 * action — were proved through `MaterialRowMenu`, which three screens rendered
 * and the rest did without. The menu is gone; the behaviours are not, so the
 * tests that hold them point here instead of being deleted with it.
 *
 * Deliberately not a screen: a screen would drag its data loading in with it,
 * and these tests are about what an action does, not about how a row is found.
 */

const DEFAULT_CONTEXT: Omit<ActionContext, 'permissions'> = {
  host: 'explorer-row',
  isOwner: true,
  currentFolderId: null,
  agentConnected: true,
  storageConnected: true,
  restitchConfigured: true,
  catalogSettingsReady: true
};

export interface MaterialSurfaceInput {
  teamId: string;
  material: MaterialRef;
  permissions: TeamPermissions;
  client: MaterialActionsClient;
  browseClient?: FolderPickerClient;
  storageKind?: TeamAnalyticsStorage | null;
  context?: Partial<ActionContext>;
  onChanged?: () => void;
  /** Handlers a real screen supplies; the registry drops an action without one. */
  handlers?: Partial<Record<string, () => void>>;
}

export function MaterialSurface({
  teamId,
  material,
  permissions,
  client,
  browseClient,
  storageKind = null,
  context,
  onChanged,
  handlers
}: MaterialSurfaceInput) {
  const host = useMaterialActionHost({
    teamId,
    material,
    permissions,
    browseClient: browseClient ?? { listMaterials: async () => [] },
    actionsClient: client,
    storageKind,
    replaceMaterialId: material.id,
    onChanged: onChanged ?? (() => {})
  });
  const list = useMaterialActionList(
    material,
    { ...DEFAULT_CONTEXT, permissions, ...context },
    { ...host.handlers, ...handlers }
  );
  return (
    <>
      <MaterialInlineActions list={list} name={material.name} />
      {host.dialogs}
    </>
  );
}

/** Render the surface and open its overflow, where every action is named. */
export async function openMaterialActions(input: MaterialSurfaceInput) {
  const result = render(
    <ToastProvider>
      <MaterialSurface {...input} />
    </ToastProvider>
  );
  await userEvent.click(
    screen.getByRole('button', { name: `Actions for ${input.material.name}` })
  );
  return result;
}

/** Render it without opening anything — for the inline row itself. */
export function renderMaterialActions(input: MaterialSurfaceInput) {
  return render(
    <ToastProvider>
      <MaterialSurface {...input} />
    </ToastProvider>
  );
}

/**
 * Press an action by its name, wherever it happens to be.
 *
 * Inline or behind the overflow is the registry's decision and it changes as
 * priorities do; a test that hard-codes which one it was is a test that fails
 * for a reason nobody cares about.
 */
export async function clickMaterialAction(name: string | RegExp) {
  const item =
    screen.queryByRole('menuitem', { name }) ?? screen.getByRole('button', { name });
  await userEvent.click(item);
}

/** Is this action on offer at all? Inline or in the menu, both count. */
export function queryMaterialAction(name: string | RegExp) {
  return (
    screen.queryByRole('menuitem', { name }) ?? screen.queryByRole('button', { name })
  );
}

/**
 * What the surface is saying about one action right now.
 *
 * Three answers, because 024 gave the middle one a voice: an action that does
 * not apply to this material is absent, one that applies but cannot run stands
 * there with the reason on it, and the rest can be pressed. Before, the middle
 * case was simply missing, and a member whose role could not rename had no way
 * to learn that renaming was a thing this product does.
 */
export function materialActionState(name: string | RegExp): 'absent' | 'blocked' | 'ready' {
  const item = queryMaterialAction(name);
  if (!item) return 'absent';
  return item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled')
    ? 'blocked'
    : 'ready';
}
