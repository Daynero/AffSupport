/**
 * 064: one assistant field change applied to a draft, the same way the form would store it.
 *
 * References are already resolved by the server (ids of the offer, buyer, account and materials,
 * the URL behind a ⟦url:N⟧ marker); this module only shapes the draft. A change the registry does
 * not open to the assistant, or a value it rejects, comes back as a reason and leaves the draft
 * as it was — never silently replaced by a default.
 */
import type { LaunchCreativeKind, LaunchDraft, LaunchSubVariable } from './launches.js';
import { addCreatives, fitCatalogToCreatives, removeCreative, rescaleCopies } from './launches/creative-distribution.js';
import { creativesPatch, draftCreatives } from './launches/creative-patch.js';
import { launchDayInZone } from './launches/defaults-merge.js';
import { launchCreativeAlias, parseLaunchConfig } from './launches/validation.js';
import { checkLaunchFieldValue, launchField, type LaunchFieldOp } from './launches/fields.js';

export interface ResolvedMaterial {
  materialId: string;
  name: string;
  kind: LaunchCreativeKind;
}

export interface AssistantApplyContext {
  now: Date;
  timezone: string;
  /** Ids for reference fields, by the text the model wrote. */
  refs: {
    offerId?: string;
    buyerId?: string;
    agentRowId?: string;
    materials?: ResolvedMaterial[];
    url?: string;
  };
}

export type AssistantApplyResult =
  | { ok: true; draft: LaunchDraft }
  | { ok: false; code: 'FIELD_FORM_ONLY' | 'FIELD_NOT_SUPPORTED' | 'INVALID_VALUE' | 'OP_NOT_ALLOWED' | 'NOT_CATALOG' | 'UNRESOLVED' };

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The creatives a draft names as resolved materials (names known only for the ones just resolved). */
function currentMaterials(draft: LaunchDraft, known: ResolvedMaterial[]): ResolvedMaterial[] {
  const byId = new Map(known.map(material => [material.materialId, material]));
  return draftCreatives(draft).map(
    creative =>
      byId.get(creative.materialId) ?? {
        materialId: creative.materialId,
        name: creative.alias,
        kind: draft.creativeKind ?? 'video'
      }
  );
}

/**
 * Creatives stored exactly as the form stores them: one material without the catalog method is
 * the single-creative shape; in the catalog method the list goes through addCreatives and
 * creativesPatch (copies, the product count, variations under re-stitch, images without it).
 */
function withCreatives(draft: LaunchDraft, change: 'set' | 'add' | 'remove', resolved: ResolvedMaterial[]): LaunchDraft {
  if (draft.method === 'other') {
    const one = change === 'remove' ? undefined : resolved[0];
    return {
      ...draft,
      materialId: one?.materialId,
      creativeAlias: one ? launchCreativeAlias(one.name) : undefined,
      creatives: undefined,
      creativeKind: undefined
    };
  }
  const n = draft.catalog?.productCount ?? resolved.length;
  if (change === 'remove') {
    let list = draftCreatives(draft);
    let productCount = n;
    for (const material of resolved) {
      const index = list.findIndex(creative => creative.materialId === material.materialId);
      if (index < 0) continue;
      list = removeCreative(list, index, productCount);
      productCount = list.reduce((sum, creative) => sum + creative.copies, 0) || productCount;
    }
    return { ...draft, ...creativesPatch(draft, list, list.length ? (draft.creativeKind ?? null) : null, productCount) };
  }
  const base = change === 'set' ? [] : draftCreatives(draft);
  const next = addCreatives(
    base,
    resolved.map(material => ({ materialId: material.materialId, alias: launchCreativeAlias(material.name) })),
    n
  );
  const kind = resolved[0]?.kind ?? draft.creativeKind ?? null;
  return { ...draft, ...creativesPatch(draft, next.creatives, kind, next.productCount) };
}

function subList(draft: LaunchDraft, slot: 'sub1' | 'sub2' | 'sub3'): LaunchSubVariable[] {
  return [...(draft.subConfig?.[slot] ?? [])];
}

/** Applies one change; the input draft is never mutated. */
export function applyAssistantChange(
  draft: LaunchDraft,
  change: { field: string; op: LaunchFieldOp; value: unknown },
  context: AssistantApplyContext
): AssistantApplyResult {
  const field = launchField(change.field);
  if (!field) return { ok: false, code: 'FIELD_NOT_SUPPORTED' };
  if (field.catalogOnly && draft.method === 'other') return { ok: false, code: 'NOT_CATALOG' };
  const checked = checkLaunchFieldValue(change.field, change.op, change.value);
  if (!checked.ok) return { ok: false, code: checked.code };
  const value = checked.value;
  const next = clone(draft);
  switch (field.kind) {
    case 'offer':
    case 'buyer':
    case 'account': {
      const key = field.path as 'offerId' | 'buyerId' | 'agentRowId';
      if (change.op === 'clear') {
        delete next[key];
        return { ok: true, draft: next };
      }
      const id = context.refs[key];
      if (!id) return { ok: false, code: 'UNRESOLVED' };
      next[key] = id;
      return { ok: true, draft: next };
    }
    case 'creatives': {
      const resolved = context.refs.materials;
      if (!resolved || resolved.length === 0) return { ok: false, code: 'UNRESOLVED' };
      const current = currentMaterials(next, resolved);
      const kinds = new Set([...(change.op === 'add' ? current : []), ...resolved].map(item => item.kind));
      if (kinds.size > 1) return { ok: false, code: 'INVALID_VALUE' };
      const mode = change.op === 'add' ? 'add' : change.op === 'remove' ? 'remove' : 'set';
      return { ok: true, draft: withCreatives(next, mode, resolved) };
    }
    case 'url': {
      if (change.op === 'clear') {
        delete next.originalUrl;
        return { ok: true, draft: next };
      }
      if (!context.refs.url) return { ok: false, code: 'UNRESOLVED' };
      next.originalUrl = context.refs.url;
      return { ok: true, draft: next };
    }
    case 'date': {
      const day =
        value === 'today'
          ? launchDayInZone(context.now, context.timezone, 0)
          : value === 'tomorrow'
            ? launchDayInZone(context.now, context.timezone, 1)
            : (value as string);
      next.launchDate = day;
      next.timezone = next.timezone ?? context.timezone;
      return { ok: true, draft: next };
    }
    case 'sub': {
      const slot = field.path.split('.')[1] as 'sub1' | 'sub2' | 'sub3';
      const items = (value as LaunchSubVariable[] | undefined) ?? [];
      let list = subList(next, slot);
      if (change.op === 'set' || change.op === 'reorder') list = items;
      else if (change.op === 'clear') list = [];
      else if (change.op === 'add') list = [...list, ...items.filter(item => !list.includes(item))];
      else list = list.filter(item => !items.includes(item));
      next.subConfig = {
        schemaVersion: 1,
        sub1: subList(next, 'sub1'),
        sub2: subList(next, 'sub2'),
        sub3: subList(next, 'sub3'),
        [slot]: list
      };
      return { ok: true, draft: next };
    }
    default: {
      const [head, key] = field.path.split('.') as [keyof LaunchDraft, string | undefined];
      if (key === undefined) {
        if (head === 'campaignCount' && draft.budgetMode === 'manual' && typeof value === 'number') {
          // As the form: the manual sums follow the count, padded with zeros; a shorter list keeps
          // its largest sum as the maximum.
          const resized = Array.from({ length: value }, (_, index) => draft.budgets?.[index] ?? 0);
          next.campaignCount = value;
          next.budgets = resized;
          if (value < (draft.campaignCount ?? 0) && resized.some(sum => sum > 0)) next.maxBudget = Math.max(...resized);
          return { ok: true, draft: next };
        }
        if (value === undefined) delete next[head];
        else (next as Record<string, unknown>)[head] = value;
        if (head === 'budgetMode' && value !== 'manual') next.budgets = null;
        if (head === 'budgets' && value !== undefined) next.budgetMode = 'manual';
        return { ok: true, draft: next };
      }
      if (!next.catalog) return { ok: false, code: 'NOT_CATALOG' };
      if (key === 'productCount' && draftCreatives(next).length > 1) {
        // As the form: several creatives keep their split, scaled; fewer products than creatives
        // is refused with the reason.
        const list = draftCreatives(next);
        if ((value as number) < list.length) return { ok: false, code: 'INVALID_VALUE' };
        return {
          ok: true,
          draft: { ...next, ...creativesPatch(next, rescaleCopies(list, value as number), next.creativeKind ?? null, value as number) }
        };
      }
      const catalog = { ...next.catalog } as Record<string, unknown>;
      if (value === undefined) delete catalog[key];
      else catalog[key] = value;
      next.catalog = catalog as unknown as LaunchDraft['catalog'];
      return { ok: true, draft: fitCatalogToCreatives(next) };
    }
  }
}

/** Registry fields that still keep a draft from generating, by the same parser generation uses. */
export function assistantBlockedFields(draft: LaunchDraft): Array<{ field: string; code: string }> {
  const parsed = parseLaunchConfig({ schemaVersion: 1, ...draft });
  if (parsed.ok) return [];
  return Object.entries(parsed.errors)
    .map(([field, code]) => ({ field, code }))
    .slice(0, 20);
}
