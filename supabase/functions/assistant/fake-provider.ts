/**
 * A stand-in for Claude on the beta stack (064), so the assistant UI, credits and every card can be
 * checked without an API key. It understands a few fixed shapes of a message, deterministically:
 *   «5 запусків ProCaps на G2, TR_16, по 2 кампанії, по 100 товарів, ⟦url:1⟧»
 *   «у другому заміни на TR_18»            (update of shown row 2)
 *   «запускай»                              (handled without a model anyway)
 * Anything else becomes out_of_scope.
 *
 *   fake        — answers
 *   fake-down   — every call fails before reaching a model
 */
import { ClaudeTransportError, type ClaudeClient, type ClaudeRequest } from '../_shared/claude.ts';

export type AssistantFakeMode = 'fake' | 'fake-down';

export function isAssistantFakeMode(value: string | undefined): value is AssistantFakeMode {
  return value === 'fake' || value === 'fake-down';
}

function message(user: string): string {
  return /<<<\n([\s\S]*)\n>>>/u.exec(user)?.[1] ?? '';
}

export function fakePlan(text: string): unknown {
  const action = {
    type: 'out_of_scope',
    offer: null as string | null,
    accounts: [] as string[],
    count: null as number | null,
    dates: null as unknown,
    base: null as string | null,
    baseRow: null as number | null,
    rows: [] as number[],
    fields: [] as Array<{ field: string; op: string; value: unknown }>,
    overrides: [],
    question: null
  };
  const materials = [...text.matchAll(/\b([A-Z]{2,3})[ _]?(\d{1,3})\b/gu)].map(m => `${m[1]}_${m[2]}`);
  const url = /⟦url:\d+⟧/u.exec(text)?.[0];
  const row = /у\s+(\d+|друг|трет|перш)/iu.exec(text);
  if (row) {
    const n = /^\d+$/u.test(row[1]!) ? Number(row[1]) : { перш: 1, друг: 2, трет: 3 }[row[1]!.toLowerCase()] ?? 1;
    action.type = 'update_fields';
    action.rows = [n];
  } else if (/запуск/iu.test(text)) {
    action.type = 'create_drafts';
    action.count = Number(/(\d+)\s+запуск/iu.exec(text)?.[1] ?? 1);
    action.offer = /запуск\S*\s+([A-Za-zА-Яа-яІіЇїЄє]+)/u.exec(text)?.[1] ?? null;
    action.accounts = [...text.matchAll(/\bG\d+\b/gu)].map(m => m[0]);
    action.base = 'offer_defaults';
    if (/сьогодні/iu.test(text)) action.dates = { kind: 'today', date: null, days: null };
  }
  if (action.type !== 'out_of_scope') {
    if (materials.length) action.fields.push({ field: 'creatives', op: 'set', value: materials });
    const campaigns = /(\d+)\s+кампан/iu.exec(text)?.[1];
    if (campaigns) action.fields.push({ field: 'campaignCount', op: 'set', value: Number(campaigns) });
    const products = /(\d+)\s+товар/iu.exec(text)?.[1];
    if (products) action.fields.push({ field: 'catalog.productCount', op: 'set', value: Number(products) });
    if (url) action.fields.push({ field: 'originalUrl', op: 'set', value: url });
  }
  return { reply: action.type === 'out_of_scope' ? 'Я допомагаю лише з чернетками запусків.' : 'Готово.', actions: [action] };
}

export function createAssistantFakeClient(mode: AssistantFakeMode): ClaudeClient {
  return {
    async create(request: ClaudeRequest) {
      if (mode === 'fake-down') throw new ClaudeTransportError(529);
      const text = JSON.stringify(fakePlan(message(request.user)));
      return { stopReason: 'end_turn', text, usage: { input: Math.ceil(request.user.length / 3), output: 300, cacheRead: 0, cacheWrite: 0 } };
    }
  };
}
