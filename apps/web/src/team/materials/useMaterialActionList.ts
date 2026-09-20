import { useMemo } from 'react';
import {
  MATERIAL_ACTIONS,
  MATERIAL_ACTION_GROUPS,
  type ActionContext,
  type Availability,
  type MaterialAction,
  type MaterialActionGroup,
  type MaterialActionId,
  type MaterialRef
} from './actions';

/**
 * The registry, resolved against one material in one place.
 *
 * Every surface calls this and renders what comes back. That is the whole of
 * the mechanism behind "the same file offers the same things wherever you meet
 * it" — and it is why that promise can be asserted by a test rather than
 * checked by eye.
 */

export interface ResolvedAction {
  action: MaterialAction;
  availability: Availability;
  run: () => void;
}

export interface ActionGroupList {
  group: MaterialActionGroup;
  actions: ResolvedAction[];
}

export interface MaterialActionList {
  /** At most four, by `inlinePriority`, and only ones that can actually run. */
  inline: ResolvedAction[];
  /** Every applying action, grouped and ordered. Empty groups are dropped. */
  groups: ActionGroupList[];
  /** How many applying actions there are in total. */
  count: number;
}

export type ActionHandlers = Partial<Record<MaterialActionId, () => void>>;

/**
 * Four, and the number is a rule rather than a taste.
 *
 * The attachment tile carried six unlabelled icons in 158 pixels and its own
 * code said four labelled ones had not fit. A row of icons nobody can read is
 * not a shortcut, it is a puzzle — so past four, the rest go behind one
 * overflow with their names on.
 */
const MAX_INLINE = 4;

/**
 * The resolution itself, with no React in it.
 *
 * Kept separate from the hook so the promise it makes — the same material
 * offers the same things on every surface — can be checked by a test rather
 * than by opening five screens and comparing them by eye.
 */
export function resolveMaterialActions(
  material: MaterialRef,
  context: ActionContext,
  handlers: ActionHandlers,
  /**
   * Fewer, where the surface is a card in a grid (024, US10): a task's
   * attachment carries open and its one make, and the rest are named in "…".
   */
  { maxInline = MAX_INLINE }: { maxInline?: number } = {}
): MaterialActionList {
  const resolved: ResolvedAction[] = [];
  for (const action of MATERIAL_ACTIONS) {
    if (!action.applies(material, context)) continue;
    const run = handlers[action.id];
    // A surface that says an action applies and cannot perform it is a bug in
    // the surface, not a state for the reader to puzzle over. Dropping it is
    // the quiet failure; the test in tests/material-action-surfaces.test.tsx
    // is the loud one.
    if (!run) continue;
    resolved.push({ action, availability: action.available(material, context), run });
  }

  const groups: ActionGroupList[] = [];
  for (const group of MATERIAL_ACTION_GROUPS) {
    const actions = resolved
      .filter(entry => entry.action.group === group)
      .sort((a, b) => a.action.order - b.action.order);
    if (actions.length > 0) groups.push({ group, actions });
  }

  const inline = resolved
    .filter(entry => entry.availability.ok && entry.action.inlinePriority !== null)
    .sort((a, b) => (b.action.inlinePriority ?? 0) - (a.action.inlinePriority ?? 0))
    .slice(0, Math.min(maxInline, MAX_INLINE));

  return { inline, groups, count: resolved.length };
}

export function useMaterialActionList(
  material: MaterialRef,
  context: ActionContext,
  handlers: ActionHandlers,
  options: { maxInline?: number } = {}
): MaterialActionList {
  const maxInline = options.maxInline;
  return useMemo(
    () => resolveMaterialActions(material, context, handlers, { maxInline }),
    [context, handlers, material, maxInline]
  );
}
