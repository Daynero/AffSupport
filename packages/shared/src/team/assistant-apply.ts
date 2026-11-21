/**
 * 064: one assistant field change applied to a draft, the same way the form would store it.
 *
 * References are already resolved by the server (ids of the offer, buyer, account and materials,
 * the URL behind a ⟦url:N⟧ marker); this module only shapes the draft. A change the registry does
 * not open to the assistant, or a value it rejects, comes back as a reason and leaves the draft
 * as it was — never silently replaced by a default.
 */
import type { LaunchCreative, LaunchCreativeKind, LaunchDraft, LaunchSubVariable } from './launches.js';
import { balanceCopies, fitCatalogToCreatives } from './launches/creative-distribution.js';
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

function withCreatives(draft: LaunchDraft, materials: ResolvedMaterial[]): LaunchDraft {
  const next = clone(draft);
  if (materials.length === 0) {
    delete next.creatives;
    delete next.materialId;
    delete next.creativeAlias;
    delete next.creativeKind;
    return next;
  }
  const kind = materials[0]!.kind;
  const productCount = next.catalog?.productCount ?? materials.length;
  const list: LaunchCreative[] = materials.map(material => ({
    materialId: material.materialId,
    alias: launchCreativeAlias(material.name),
    copies: 1,
    pinned: null
  }));
  const creatives = balanceCopies(list, Math.max(productCount, list.length));
  next.creatives = creatives;
  next.materialId = creatives[0]!.materialId;
  next.creativeAlias = creatives[0]!.alias;
  next.creativeKind = kind;
  return fitCatalogToCreatives(next);
}

function currentMaterials(draft: LaunchDraft, known: ResolvedMaterial[]): ResolvedMaterial[] {
  const byId = new Map(known.map(material => [material.materialId, material]));
  return (draft.creatives ?? []).map(
    creative =>
      byId.get(creative.materialId) ?? {
        materialId: creative.materialId,
        name: creative.alias,
        kind: draft.creativeKind ?? 'video'
      }
  );
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
      let list: ResolvedMaterial[];
      if (change.op === 'set' || change.op === 'reorder') list = resolved;
      else if (change.op === 'add')
        list = [...current, ...resolved.filter(item => !current.some(c => c.materialId === item.materialId))];
      else list = current.filter(item => !resolved.some(r => r.materialId === item.materialId));
      if (list.some(item => item.kind !== list[0]!.kind)) return { ok: false, code: 'INVALID_VALUE' };
      return { ok: true, draft: withCreatives(next, list) };
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
        if (value === undefined) delete next[head];
        else (next as Record<string, unknown>)[head] = value;
        if (head === 'budgetMode' && value !== 'manual') next.budgets = null;
        if (head === 'budgets' && value !== undefined) next.budgetMode = 'manual';
        if (head === 'campaignCount' && next.budgetMode === 'manual' && Array.isArray(next.budgets)) {
          // A changed campaign count no longer matches the manual sums: back to one sum each.
          next.budgetMode = 'single';
          next.budgets = null;
        }
        return { ok: true, draft: next };
      }
      if (!next.catalog) return { ok: false, code: 'NOT_CATALOG' };
      const catalog = { ...next.catalog } as Record<string, unknown>;
      if (value === undefined) delete catalog[key];
      else catalog[key] = value;
      next.catalog = catalog as unknown as LaunchDraft['catalog'];
      if (key === 'productCount' && next.creatives?.length) {
        next.creatives = balanceCopies(next.creatives, value as number);
      }
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
