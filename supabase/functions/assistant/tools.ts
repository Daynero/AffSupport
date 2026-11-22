/**
 * 064: the assistant's space tools — everything a person does in a space besides launches
 * (owner, 2026-11-22: «додай всі можливі дії в просторі»). The model only names a tool and writes
 * its arguments as the person did; a tool resolves the names against the space with the person's
 * own token and answers with a card built from stored rows:
 *
 * - a read tool answers at once with a `table` card — numbers come from the database, never from
 *   the model, and totals are the ones the Accounts tab shows (the same shared report);
 * - a write tool only prepares a `review` card with `purpose: 'tool'` listing exactly what will
 *   change, with the versions it saw; the browser performs it through the same API the screens
 *   use when the person presses the button, and refuses a row that changed since.
 */
// @deno-types="../../../packages/shared/dist/team/agent-finance.d.ts"
import {
  financeMoney,
  parseFinanceMoney,
  parseFinanceSnapshot,
  validFinanceDate,
  type FinanceMetric,
  type FinanceSnapshot
} from '../../../packages/shared/dist/team/agent-finance.js';
// @deno-types="../../../packages/shared/dist/team/agent-finance-report.d.ts"
import { buildFinanceReport } from '../../../packages/shared/dist/team/agent-finance-report.js';
// @deno-types="../../../packages/shared/dist/team/assistant.d.ts"
import type { AssistantToolArg } from '../../../packages/shared/dist/team/assistant.js';

export type ToolRpc = (
  name: string,
  args: Record<string, unknown>
) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;

export interface ToolDeps {
  teamId: string;
  /** The person writing: «на мене», «мені» name them. */
  userId: string;
  /**
   * Files an earlier step of the same message renames, new name → old name: «перейменуй X на Y і
   * перенеси його в Z» names Y before it exists. The cards act on ids, so finding it as X is right.
   */
  renamed?: Map<string, string>;
  callerRpc: ToolRpc;
  timezone: string;
  now: Date;
}

export interface ToolCard {
  kind: 'table' | 'review' | 'result';
  payload: Record<string, unknown>;
}

export class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    readonly written: string = ''
  ) {
    super(code);
  }
}

/** The bounds every tool keeps, so one message can never touch the whole space by accident. */
export const TOOL_LIMITS = { rows: 200, days: 92 } as const;

type Args = Map<string, AssistantToolArg['value']>;

function argMap(args: AssistantToolArg[]): Args {
  return new Map(args.map(arg => [arg.name, arg.value]));
}

function text(args: Args, name: string): string | null {
  const value = args.get(name);
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function list(args: Args, name: string): string[] {
  const value = args.get(name);
  if (Array.isArray(value))
    return value
      .map(String)
      .map(item => item.trim())
      .filter(Boolean);
  if (typeof value === 'string' && value.trim())
    return value
      .split(/[,;\n]/u)
      .map(item => item.trim())
      .filter(Boolean);
  if (typeof value === 'number') return [String(value)];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcCode(error: { message?: string; code?: string } | null): string {
  const found = `${error?.message ?? ''} ${error?.code ?? ''}`.match(/[A-Z][A-Z0-9_]{3,}/u);
  return found?.[0] ?? 'UNAVAILABLE';
}

async function call(deps: ToolDeps, name: string, args: Record<string, unknown>) {
  const { data, error } = await deps.callerRpc(name, { p_team: deps.teamId, ...args });
  if (error) throw new ToolRefusal(rpcCode(error));
  return data;
}

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk').trim();

// ───────────────────────────── dates ─────────────────────────────

function dayInZone(now: Date, timezone: string, shift = 0): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  const date = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + shift);
  return date.toISOString().slice(0, 10);
}

/** «2026-11-21», «today», «yesterday»; a future day is refused, as the Accounts tab does. */
function day(deps: ToolDeps, written: string | null, fallback: string): string {
  const today = dayInZone(deps.now, deps.timezone);
  const value = !written
    ? fallback
    : /^(today|сьогодні)$/iu.test(written)
      ? today
      : /^(yesterday|вчора|учора)$/iu.test(written)
        ? dayInZone(deps.now, deps.timezone, -1)
        : written;
  if (!validFinanceDate(value)) throw new ToolRefusal('INVALID_DATE', written ?? '');
  if (value > today) throw new ToolRefusal('FUTURE_FINANCE_DATE', value);
  return value;
}

function period(deps: ToolDeps, args: Args): { from: string; to: string } {
  const today = dayInZone(deps.now, deps.timezone);
  const from = day(deps, text(args, 'from') ?? text(args, 'date'), today);
  const to = day(deps, text(args, 'to') ?? text(args, 'date') ?? text(args, 'from'), from);
  const [a, b] = from <= to ? [from, to] : [to, from];
  const span = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
  if (span >= TOOL_LIMITS.days) throw new ToolRefusal('PERIOD_TOO_LONG', `${a}…${b}`);
  return { from: a, to: b };
}

// ───────────────────────── ad accounts ─────────────────────────

interface AdAccount {
  id: string;
  agentId: string;
  account: string;
  accountId: string;
  label: string;
  tags: string[];
}

async function adAccounts(deps: ToolDeps): Promise<AdAccount[]> {
  const data = await call(deps, 'list_team_accounts', {});
  const out: AdAccount[] = [];
  for (const account of Array.isArray(data) ? data : []) {
    if (!isRecord(account) || !Array.isArray(account.agents) || typeof account.id !== 'string')
      continue;
    const name = typeof account.name === 'string' ? account.name.trim() : '';
    for (const agent of account.agents) {
      if (!isRecord(agent) || typeof agent.id !== 'string' || typeof agent.agent_id !== 'string')
        continue;
      if (agent.archived_at) continue;
      const tags = Array.isArray(agent.labels)
        ? agent.labels.flatMap(label =>
            isRecord(label) && typeof label.name === 'string' ? [label.name] : []
          )
        : [];
      out.push({
        id: agent.id,
        agentId: agent.agent_id,
        account: name,
        accountId: account.id,
        label: name ? `${name}-${agent.agent_id.slice(-3)}` : agent.agent_id,
        tags
      });
    }
  }
  return out;
}

/**
 * Written references to ad accounts: «всі»/«*», an account («g18» — all its ad accounts), one ad
 * account («g18-244», its full ID, or its last digits), or a tag («#2», «tag:#2»).
 */
export function pickAdAccounts(
  all: AdAccount[],
  written: string[]
): { picked: AdAccount[]; missing: string[] } {
  const picked = new Map<string, AdAccount>();
  const missing: string[] = [];
  for (const raw of written) {
    const ref = fold(raw);
    if (['*', 'all', 'всі', 'усі', 'все'].includes(ref)) {
      all.forEach(agent => picked.set(agent.id, agent));
      continue;
    }
    const tag = ref.startsWith('tag:') ? ref.slice(4).trim() : null;
    const byTag = (name: string) => all.filter(agent => agent.tags.some(t => fold(t) === name));
    const found = tag
      ? byTag(tag)
      : (() => {
          const byLabel = all.filter(
            agent => fold(agent.label) === ref || fold(agent.agentId) === ref
          );
          if (byLabel.length) return byLabel;
          const byAccount = all.filter(agent => fold(agent.account) === ref);
          if (byAccount.length) return byAccount;
          const tagged = byTag(ref);
          if (tagged.length) return tagged;
          return /^\d{3,}$/u.test(ref) ? all.filter(agent => agent.agentId.endsWith(ref)) : [];
        })();
    if (found.length === 0) missing.push(raw);
    found.forEach(agent => picked.set(agent.id, agent));
  }
  return { picked: [...picked.values()], missing };
}

// ───────────────────────────── money ─────────────────────────────

function cents(value: string | null): bigint | null {
  if (value === null) return null;
  const parsed = parseFinanceMoney(value);
  return typeof parsed === 'bigint' ? parsed : null;
}

function add(a: bigint | null, b: bigint | null): bigint | null {
  return a === null ? b : b === null ? a : a + b;
}

const show = (value: bigint | null) => (value === null ? null : financeMoney(value));

async function snapshot(deps: ToolDeps, from: string, to: string): Promise<FinanceSnapshot> {
  const data = await call(deps, 'get_team_agent_finance_v2', {
    p_from: from,
    p_to: to,
    p_timezone: deps.timezone
  });
  const parsed = parseFinanceSnapshot(data);
  if (!parsed) throw new ToolRefusal('INVALID_RESPONSE');
  return { ...parsed, timezone: deps.timezone };
}

const naturally = new Intl.Collator('uk', { numeric: true, sensitivity: 'base' });

/** The group of ad accounts without a tag; the window shows it in the person's language. */
export const UNTAGGED = '{untagged}';

function tagKey(tags: readonly string[]): string {
  return [...new Set(tags)].sort(naturally.compare).join(' + ');
}

// ───────────────────────────── tools ─────────────────────────────

/**
 * «скільки витрат за вчора», «поповнення за тиждень по акаунтах», «витрати по тегах за місяць».
 * The totals are those of the Accounts tab's period details: the shared report over the same rows.
 */
async function financeReport(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const { from, to } = period(deps, args);
  const by = text(args, 'by') ?? 'total';
  if (!['total', 'account', 'ad_account', 'tag', 'day'].includes(by))
    throw new ToolRefusal('INVALID_INPUT', by);
  const scope = list(args, 'scope');
  const [snap, agents] = await Promise.all([snapshot(deps, from, to), adAccounts(deps)]);
  const report = buildFinanceReport(snap);
  const chosen = scope.length ? pickAdAccounts(agents, scope) : null;
  if (chosen && chosen.picked.length === 0)
    throw new ToolRefusal('NOT_FOUND', chosen.missing.join(', '));
  const ids = chosen ? new Set(chosen.picked.map(agent => agent.id)) : null;
  const tags = new Map(agents.map(agent => [agent.id, agent.tags]));
  const columns = report.columns.filter(column => !ids || ids.has(column.agentRowId));
  const groups = new Map<string, { spend: bigint | null; topup: bigint | null }>();
  const bump = (key: string, spend: bigint | null, topup: bigint | null) => {
    const group = groups.get(key) ?? { spend: null, topup: null };
    group.spend = add(group.spend, spend);
    group.topup = add(group.topup, topup);
    groups.set(key, group);
  };
  for (const column of columns) {
    if (by === 'day') {
      for (const date of report.dates)
        bump(
          date,
          cents(report.cell(column.accountId, column.agentRowId, date, 'spend')),
          cents(report.cell(column.accountId, column.agentRowId, date, 'topup'))
        );
      continue;
    }
    const key =
      by === 'account'
        ? column.accountName
        : by === 'ad_account'
          ? `${column.accountName}-${column.agentId.slice(-3)}`
          : by === 'tag'
            ? tagKey(tags.get(column.agentRowId) ?? []) || UNTAGGED
            : 'total';
    bump(key, cents(column.totals.spend), cents(column.totals.topup));
  }
  const total = [...groups.values()].reduce(
    (sum, group) => ({ spend: add(sum.spend, group.spend), topup: add(sum.topup, group.topup) }),
    { spend: null as bigint | null, topup: null as bigint | null }
  );
  const ordered = [...groups.entries()]
    .filter(([, group]) => group.spend !== null || group.topup !== null)
    .sort(([a], [b]) => (a === UNTAGGED ? 1 : b === UNTAGGED ? -1 : naturally.compare(a, b)));
  return {
    kind: 'table',
    payload: {
      tool: 'finance_report',
      from,
      to,
      by,
      currency: 'USD',
      columns: by === 'total' ? ['spend', 'topup'] : ['group', 'spend', 'topup'],
      rows:
        by === 'total'
          ? []
          : ordered
              .slice(0, TOOL_LIMITS.rows)
              .map(([key, group]) => [key, show(group.spend), show(group.topup)]),
      total: [show(total.spend), show(total.topup)],
      missing: chosen?.missing ?? [],
      truncated: ordered.length > TOOL_LIMITS.rows
    }
  };
}

/**
 * «дай виписку поповнень за тегами»: every top-up of the period under its tags (an ad account with
 * several tags sits under all of them joined, never twice), with a text to copy as the Accounts
 * tab's «копіювати за тегами» does — for a period, not one day.
 */
async function topupStatement(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const { from, to } = period(deps, args);
  const by = text(args, 'by') === 'account' ? 'account' : 'tag';
  const scope = list(args, 'scope');
  const [snap, agents] = await Promise.all([snapshot(deps, from, to), adAccounts(deps)]);
  const chosen = scope.length ? pickAdAccounts(agents, scope) : null;
  const ids = chosen ? new Set(chosen.picked.map(agent => agent.id)) : null;
  const tags = new Map(agents.map(agent => [agent.id, agent.tags]));
  const rows = buildFinanceReport(snap).topups.filter(
    row => row.value !== '0.00' && (!ids || ids.has(row.agentRowId))
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key =
      by === 'account' ? row.accountName : tagKey(tags.get(row.agentRowId) ?? []) || UNTAGGED;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === UNTAGGED ? 1 : b === UNTAGGED ? -1 : naturally.compare(a, b)
  );
  const total = rows.reduce<bigint | null>((sum, row) => add(sum, cents(row.value)), null);
  const plain = (value: string) => `$${value.replace(/\.00$/u, '')}`;
  const copyText = rows.length
    ? [
        `${from === to ? from : `${from} — ${to}`} · USD`,
        ...ordered.map(([key, group]) => {
          const subtotal = group.reduce<bigint | null>(
            (sum, row) => add(sum, cents(row.value)),
            null
          );
          return [
            `${key.replaceAll('№', '#')} — ${plain(show(subtotal) ?? '0.00')}`,
            ...group.map(
              row =>
                `${from === to ? '' : `${row.date.slice(5)} · `}${row.agentId} - ${plain(row.value)}`
            )
          ].join('\n');
        }),
        `Σ ${plain(show(total) ?? '0.00')}`
      ].join('\n\n')
    : null;
  return {
    kind: 'table',
    payload: {
      tool: 'topup_statement',
      from,
      to,
      by,
      currency: 'USD',
      columns: ['group', 'count', 'topup'],
      rows: ordered.map(([key, group]) => [
        key,
        String(group.length),
        show(group.reduce<bigint | null>((sum, row) => add(sum, cents(row.value)), null))
      ]),
      total: [String(rows.length), show(total)],
      copyText,
      missing: chosen?.missing ?? [],
      truncated: false
    }
  };
}

/**
 * «простав поповнення 100 на g18-244 і 50 на g18-257», «витрати вчора g4 по 30»: the cells the
 * button will set, each with the value it holds now and its version — a cell somebody changed in
 * between is refused by the server, never overwritten.
 */
async function setFinance(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const metric = (text(args, 'metric') ?? 'topup') as FinanceMetric;
  if (!['topup', 'spend', 'balance'].includes(metric))
    throw new ToolRefusal('INVALID_INPUT', metric);
  const date = day(deps, text(args, 'date'), dayInZone(deps.now, deps.timezone));
  const entries: Array<{ refs: string[]; amount: string }> = [];
  for (const entry of list(args, 'entries')) {
    const match = entry.match(/^(.+?)\s*[=:]\s*\$?\s*([\d.,\s]+)$/u);
    if (!match) throw new ToolRefusal('INVALID_INPUT', entry);
    entries.push({ refs: [match[1]!], amount: match[2]!.replace(/\s/gu, '') });
  }
  const shared = text(args, 'amount');
  if (shared) entries.push({ refs: list(args, 'scope'), amount: shared });
  if (entries.length === 0 || entries.some(entry => entry.refs.length === 0))
    throw new ToolRefusal('INVALID_INPUT', 'entries');
  const [snap, agents] = await Promise.all([snapshot(deps, date, date), adAccounts(deps)]);
  const items: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = parseFinanceMoney(entry.amount);
    if (typeof value !== 'bigint') throw new ToolRefusal('INVALID_AMOUNT', entry.amount);
    const { picked, missing: lost } = pickAdAccounts(agents, entry.refs);
    missing.push(...lost);
    for (const agent of picked) {
      if (seen.has(agent.id)) throw new ToolRefusal('DUPLICATE_TARGET', agent.label);
      seen.add(agent.id);
      const placement = snap.placements.find(
        p =>
          p.agentRowId === agent.id && p.startsOn <= date && (p.endsOn === null || date < p.endsOn)
      );
      if (!placement) {
        missing.push(`${agent.label} · ${date}`);
        continue;
      }
      const field = snap.fields.find(
        f => f.agentRowId === agent.id && f.date === date && f.metric === metric
      );
      const to = financeMoney(value);
      items.push({
        agentRowId: agent.id,
        label: agent.label,
        agentId: agent.agentId,
        from: field?.value ?? null,
        to,
        version: field?.version ?? '0',
        placementId: placement.id,
        unchanged: (field?.value ?? null) === to
      });
    }
  }
  if (items.length > TOOL_LIMITS.rows) throw new ToolRefusal('TOO_MANY', String(items.length));
  if (items.length === 0) throw new ToolRefusal('NOT_FOUND', missing.join(', '));
  const total = items.reduce<bigint>((sum, item) => sum + (cents(item.to as string) ?? 0n), 0n);
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'set_finance',
      metric,
      date,
      timezone: deps.timezone,
      items,
      total: financeMoney(total),
      overwrites: items.filter(item => item.from !== null && !item.unchanged).length,
      missing
    }
  };
}

// ───────────────────────── materials ─────────────────────────

interface Material {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  parentFolderId: string | null;
  tags: string[];
  offer: string | null;
  geo: string | null;
}

interface Folder {
  id: string;
  driveId: string;
  parentDriveId: string | null;
  name: string;
  path: string;
}

const KINDS = ['folder', 'image', 'video', 'landing', 'archive', 'transcript', 'document', 'other'];

/** «TR_16», «TR 16.mp4», «tr16» all name the same file. */
const loose = (value: string) =>
  fold(value)
    .replace(/\.[a-z0-9]{2,5}$/u, '')
    .replace(/[\s_\-.]+/gu, '');

function material(item: unknown): Material | null {
  if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  return {
    id: item.id,
    name: item.name,
    kind: typeof item.kind === 'string' ? item.kind : 'other',
    category: typeof item.category === 'string' ? item.category : null,
    parentFolderId: typeof item.parentFolderId === 'string' ? item.parentFolderId : null,
    tags: Array.isArray(item.tags)
      ? item.tags.filter((t): t is string => typeof t === 'string')
      : [],
    offer: typeof item.offer === 'string' ? item.offer : null,
    geo: typeof item.geo === 'string' ? item.geo : null
  };
}

async function search(
  deps: ToolDeps,
  query: string,
  options: {
    kinds?: string[];
    folder?: Folder | null;
    filters?: Record<string, string[]>;
    pages?: number;
  } = {}
): Promise<{ items: Material[]; total: number }> {
  const items: Material[] = [];
  let total = 0;
  for (let page = 1; page <= (options.pages ?? 1); page++) {
    const data = await call(deps, 'search_materials', {
      p_query: query || null,
      p_filters: options.filters ?? {},
      p_page: page,
      p_page_size: 100,
      ...(options.kinds?.length ? { p_kind: options.kinds } : {}),
      ...(options.folder ? { p_parent_folder_id: options.folder.driveId, p_recursive: true } : {})
    });
    const found = isRecord(data) && Array.isArray(data.items) ? data.items : [];
    total = isRecord(data) && typeof data.total === 'number' ? data.total : found.length;
    for (const item of found) {
      const parsed = material(item);
      if (parsed) items.push(parsed);
    }
    if (items.length >= total || found.length < 100) break;
  }
  return { items, total };
}

async function folders(deps: ToolDeps): Promise<Folder[]> {
  const data = await call(deps, 'list_team_folder_tree', {});
  const rows = (Array.isArray(data) ? data : []).flatMap(row =>
    isRecord(row) &&
    typeof row.id === 'string' &&
    typeof row.drive_file_id === 'string' &&
    typeof row.name === 'string'
      ? [
          {
            id: row.id,
            driveId: row.drive_file_id,
            parentDriveId: typeof row.parent_folder_id === 'string' ? row.parent_folder_id : null,
            name: row.name,
            path: row.name
          }
        ]
      : []
  );
  const byDrive = new Map(rows.map(row => [row.driveId, row]));
  for (const row of rows) {
    const names = [row.name];
    let parent = row.parentDriveId ? byDrive.get(row.parentDriveId) : undefined;
    for (let depth = 0; parent && depth < 20; depth++) {
      names.unshift(parent.name);
      parent = parent.parentDriveId ? byDrive.get(parent.parentDriveId) : undefined;
    }
    row.path = names.join(' / ');
  }
  return rows;
}

const ROOT_WORDS = ['root', 'корінь', 'корінь простору', '/', 'мій диск', 'диск'];

/** A folder by its name or its path («Креативи / TR»); several with that name → refused. */
function pickFolder(all: Folder[], written: string): Folder | 'root' | null {
  const ref = fold(written)
    .replace(/\s*\/\s*/gu, ' / ')
    .trim();
  if (ROOT_WORDS.includes(ref)) return 'root';
  const exact = all.filter(folder => fold(folder.path) === ref || fold(folder.name) === ref);
  const found = exact.length ? exact : all.filter(folder => loose(folder.name) === loose(written));
  if (found.length > 1)
    throw new ToolRefusal('AMBIGUOUS_FOLDER', `${written}: ${found.map(f => f.path).join('; ')}`);
  return found[0] ?? null;
}

/**
 * The files a step means: named one by one («тр16, тр23»), or a selection («всі відео в папці
 * TR», «усе з тегом test»). A name that fits several files is reported, not guessed.
 */
async function pickMaterials(
  deps: ToolDeps,
  args: Args,
  tree: Folder[] | null
): Promise<{ items: Material[]; missing: string[]; truncated: boolean }> {
  const names = list(args, 'items');
  const query = text(args, 'query') ?? '';
  const kinds = list(args, 'kind')
    .map(kind => fold(kind))
    .filter(kind => KINDS.includes(kind));
  const inFolder = text(args, 'in_folder');
  const tag = text(args, 'tag');
  const offer = text(args, 'offer');
  const geo = text(args, 'geo');
  const missing: string[] = [];
  const picked = new Map<string, Material>();
  for (const written of names.slice(0, TOOL_LIMITS.rows)) {
    const name = deps.renamed?.get(loose(written)) ?? written;
    const { items } = await search(deps, name.replace(/\.[a-z0-9]{2,5}$/iu, ''), {
      kinds: kinds.length ? kinds : undefined
    });
    let found = items.filter(item => fold(item.name) === fold(name));
    if (!found.length) found = items.filter(item => loose(item.name) === loose(name));
    // A video stands for its creative; its transcript and catalogs follow it on their own.
    if (found.length > 1) {
      const primary = found.filter(item => !['transcript'].includes(item.kind));
      if (primary.length === 1) found = primary;
    }
    if (found.length === 1) picked.set(found[0]!.id, found[0]!);
    else missing.push(found.length ? `${written} (${found.length})` : written);
  }
  let truncated = false;
  if (!names.length && (query || kinds.length || inFolder || tag || offer || geo)) {
    let folder: Folder | null = null;
    if (inFolder) {
      const chosen = pickFolder(tree ?? (await folders(deps)), inFolder);
      if (chosen === null) throw new ToolRefusal('FOLDER_NOT_FOUND', inFolder);
      folder = chosen === 'root' ? null : chosen;
    }
    const filters: Record<string, string[]> = {};
    if (offer) filters.offer = [offer];
    if (geo) filters.geo = [geo.toUpperCase()];
    const { items, total } = await search(deps, query || (tag ?? ''), {
      kinds: kinds.length ? kinds : undefined,
      folder,
      filters,
      pages: 2
    });
    for (const item of items) {
      if (tag && !item.tags.some(t => fold(t) === fold(tag))) continue;
      if (folder && item.id === folder.id) continue;
      picked.set(item.id, item);
    }
    truncated = total > items.length;
  }
  const items = [...picked.values()];
  if (items.length > TOOL_LIMITS.rows) {
    truncated = true;
    items.length = TOOL_LIMITS.rows;
  }
  return { items, missing, truncated };
}

const fileItem = <T extends Record<string, unknown>>(item: Material, extra: T = {} as T) => ({
  id: item.id,
  label: item.name,
  category: item.category,
  ...extra
});

/** «знайди креативи прокапс», «покажи всі відео в папці TR»: what the explorer search finds. */
async function findMaterials(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const tree = text(args, 'in_folder') ? await folders(deps) : null;
  const hasFilter = ['query', 'kind', 'in_folder', 'tag', 'offer', 'geo'].some(name =>
    args.has(name)
  );
  const picked = list(args, 'items').length
    ? await pickMaterials(deps, args, tree)
    : hasFilter
      ? await pickMaterials(deps, args, tree)
      : { items: [], missing: [], truncated: false };
  return {
    kind: 'table',
    payload: {
      tool: 'find_materials',
      columns: ['name', 'kind', 'offer', 'tags'],
      rows: picked.items.map(item => [
        item.name,
        item.kind === 'folder' ? 'folder' : (item.category ?? item.kind),
        [item.offer, item.geo].filter(Boolean).join(' · ') || null,
        item.tags.join(', ') || null
      ]),
      total: null,
      count: picked.items.length,
      missing: picked.missing,
      truncated: picked.truncated
    }
  };
}

/** «створи папку TR у Креативах», several at once. */
async function createFolders(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const names = list(args, 'names').length ? list(args, 'names') : list(args, 'name');
  if (!names.length) throw new ToolRefusal('INVALID_INPUT', 'names');
  const tree = await folders(deps);
  const parentWritten = text(args, 'parent');
  const found = parentWritten ? pickFolder(tree, parentWritten) : 'root';
  // «створи в QA папки a і b» when QA is not there yet: QA is made first, where its path says.
  let parent: Folder | 'root' | { create: string; within: Folder | 'root' } | null = found;
  if (found === null && parentWritten) {
    const parts = parentWritten
      .split('/')
      .map(part => part.trim())
      .filter(Boolean);
    const within = parts.length > 1 ? pickFolder(tree, parts.slice(0, -1).join(' / ')) : 'root';
    if (within === null) throw new ToolRefusal('FOLDER_NOT_FOUND', parentWritten);
    parent = { create: parts.at(-1)!, within };
  }
  if (parent === null) throw new ToolRefusal('FOLDER_NOT_FOUND', parentWritten ?? '');
  const known = new Set(tree.map(folder => folder.driveId));
  // Already there: the same name under the same parent. A root folder's parent is no listed
  // folder; a parent made by this card has nothing in it yet.
  const under = (folder: Folder) =>
    parent === 'root'
      ? folder.parentDriveId === null || !known.has(folder.parentDriveId)
      : 'driveId' in parent
        ? folder.parentDriveId === parent.driveId
        : false;
  const items = names.slice(0, 50).map(name => {
    if (/[\\/]/u.test(name) || name.length > 200) throw new ToolRefusal('INVALID_NAME', name);
    const exists = tree.some(folder => fold(folder.name) === fold(name) && under(folder));
    return { label: name, name, exists };
  });
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'create_folders',
      parent:
        parent === 'root'
          ? null
          : 'create' in parent
            ? {
                create: parent.create,
                parentId: parent.within === 'root' ? null : parent.within.id,
                label: parentWritten
              }
            : { id: parent.id, label: parent.path },
      items
    }
  };
}

/** «перенеси тр16 і тр23 в папку TR» — the folder is made first when it does not exist yet. */
async function moveMaterials(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const tree = await folders(deps);
  const target = text(args, 'destination');
  if (!target) throw new ToolRefusal('INVALID_INPUT', 'destination');
  const destination = pickFolder(tree, target);
  const chosen = await pickMaterials(deps, args, tree);
  // Soty moves files, not folders — the explorer drops files on a folder, and the server's move
  // takes a file with its transcript and catalogs. A folder named here is told, not attempted.
  const folderNames = chosen.items.filter(item => item.kind === 'folder').map(item => item.name);
  const picked = { ...chosen, items: chosen.items.filter(item => item.kind !== 'folder') };
  if (!picked.items.length)
    throw new ToolRefusal(
      folderNames.length ? 'FOLDER_MOVE_UNSUPPORTED' : 'NOT_FOUND',
      folderNames.length ? folderNames.join(', ') : picked.missing.join(', ')
    );
  const parentWritten = text(args, 'parent');
  const parent = parentWritten ? pickFolder(tree, parentWritten) : 'root';
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'move_materials',
      destination:
        destination === 'root'
          ? { root: true, label: '/' }
          : destination
            ? { id: destination.id, driveId: destination.driveId, label: destination.path }
            : {
                create: target.split('/').pop()!.trim(),
                parentId: parent && parent !== 'root' ? parent.id : null,
                label: target
              },
      items: picked.items
        .filter(
          item =>
            !destination || destination === 'root' || item.parentFolderId !== destination.driveId
        )
        .map(item => fileItem(item)),
      folders: folderNames,
      already: picked.items.filter(
        item => destination && destination !== 'root' && item.parentFolderId === destination.driveId
      ).length,
      missing: picked.missing,
      truncated: picked.truncated
    }
  };
}

/**
 * Renames many at once. Either explicit pairs («тр16 = TR_16_final»), or one rule for a selection:
 * prefix, suffix, replace a piece, or a template with {n} (a running number), {name}, {offer}.
 * Soty computes every new name here, so the card shows exactly what the files will be called.
 */
async function renameMaterials(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const pairs = list(args, 'pairs').map(pair => {
    const match = pair.match(/^(.+?)\s*(?:=>|->|→|=)\s*(.+)$/u);
    if (!match) throw new ToolRefusal('INVALID_INPUT', pair);
    return { from: match[1]!.trim(), to: match[2]!.trim() };
  });
  let rows: Array<{ item: Material; to: string }> = [];
  const missing: string[] = [];
  let truncated = false;
  if (pairs.length) {
    for (const pair of pairs.slice(0, TOOL_LIMITS.rows)) {
      const { items, missing: lost } = await pickMaterials(
        deps,
        new Map([['items', [pair.from]]]),
        null
      );
      missing.push(...lost);
      if (items[0]) rows.push({ item: items[0], to: pair.to });
    }
  } else {
    const picked = await pickMaterials(deps, args, null);
    missing.push(...picked.missing);
    truncated = picked.truncated;
    const prefix = text(args, 'prefix') ?? '';
    const suffix = text(args, 'suffix') ?? '';
    const find = text(args, 'find');
    const replace = text(args, 'replace') ?? '';
    const template = text(args, 'template');
    const start = Number(text(args, 'start') ?? '1');
    if (!prefix && !suffix && find === null && !template)
      throw new ToolRefusal('INVALID_INPUT', 'rule');
    const ordered = [...picked.items].sort((a, b) => naturally.compare(a.name, b.name));
    rows = ordered.map((item, index) => {
      const dot = item.kind === 'folder' ? -1 : item.name.lastIndexOf('.');
      const stem = dot > 0 ? item.name.slice(0, dot) : item.name;
      let next = template
        ? template
            .replaceAll('{n}', String((Number.isFinite(start) ? start : 1) + index))
            .replaceAll('{name}', stem)
            .replaceAll('{offer}', item.offer ?? '')
            .replaceAll('{geo}', item.geo ?? '')
        : stem;
      if (find !== null) next = next.split(find).join(replace);
      return { item, to: `${prefix}${next}${suffix}` };
    });
  }
  // A new name keeps the extension unless the person wrote one.
  const items = rows.map(({ item, to }) => {
    const dot = item.kind === 'folder' ? -1 : item.name.lastIndexOf('.');
    const ext = dot > 0 ? item.name.slice(dot) : '';
    const name = ext && !/\.[a-z0-9]{2,5}$/iu.test(to) ? `${to.trim()}${ext}` : to.trim();
    if (!name || /[\\/]/u.test(name) || name.length > 200)
      throw new ToolRefusal('INVALID_NAME', to);
    return fileItem(item, { from: item.name, to: name });
  });
  const changed = items.filter(item => item.from !== item.to);
  const clash = new Set<string>();
  for (const item of changed) {
    if (clash.has(fold(item.to as string)))
      throw new ToolRefusal('NAME_CONFLICT', item.to as string);
    clash.add(fold(item.to as string));
  }
  if (!changed.length) throw new ToolRefusal('NOTHING_TO_CHANGE', '');
  return {
    kind: 'review',
    payload: { purpose: 'tool', tool: 'rename_materials', items: changed, missing, truncated }
  };
}

/** «повісь тег test на тр16 і тр23», «прибери тег old з усіх відео в TR», offer/geo too. */
async function editMaterials(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const addTags = list(args, 'add_tags');
  const removeTags = list(args, 'remove_tags').map(fold);
  const offer = text(args, 'set_offer');
  const geo = text(args, 'set_geo');
  if (!addTags.length && !removeTags.length && offer === null && geo === null)
    throw new ToolRefusal('INVALID_INPUT', 'change');
  if (addTags.some(tag => tag.length > 64)) throw new ToolRefusal('INVALID_NAME', 'tag');
  const picked = await pickMaterials(deps, args, null);
  if (!picked.items.length) throw new ToolRefusal('NOT_FOUND', picked.missing.join(', '));
  const items = picked.items.flatMap(item => {
    const tags = [...item.tags.filter(tag => !removeTags.includes(fold(tag)))];
    for (const tag of addTags) if (!tags.some(t => fold(t) === fold(tag))) tags.push(tag);
    const patch: Record<string, unknown> = {};
    if (tags.join('\n') !== item.tags.join('\n')) patch.tags = tags.slice(0, 50);
    if (offer !== null && offer !== item.offer) patch.offer = offer;
    if (geo !== null && geo.toUpperCase() !== item.geo) patch.geo = geo.toUpperCase();
    if (!Object.keys(patch).length) return [];
    return [
      fileItem(item, {
        from: [item.offer, item.geo, item.tags.join(', ')].filter(Boolean).join(' · ') || null,
        to: [
          patch.offer ?? item.offer,
          patch.geo ?? item.geo,
          ((patch.tags as string[]) ?? item.tags).join(', ')
        ]
          .filter(Boolean)
          .join(' · '),
        patch
      })
    ];
  });
  if (!items.length) throw new ToolRefusal('NOTHING_TO_CHANGE', '');
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'edit_materials',
      items,
      missing: picked.missing,
      truncated: picked.truncated
    }
  };
}

/** «видали тр16», «видали всі зображення з папки old» — into the Drive trash, restorable there. */
async function trashMaterials(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const picked = await pickMaterials(deps, args, null);
  if (!picked.items.length) throw new ToolRefusal('NOT_FOUND', picked.missing.join(', '));
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'trash_materials',
      danger: true,
      items: picked.items.map(item => fileItem(item, { kind: item.kind })),
      folders: picked.items.filter(item => item.kind === 'folder').length,
      missing: picked.missing,
      truncated: picked.truncated
    }
  };
}

// ───────────────────────── catalogs ─────────────────────────

interface Catalog {
  id: string;
  name: string;
  video: string | null;
  folder: string | null;
  products: number | null;
  updatedAt: string | null;
  error: string | null;
  interval: string | null;
}

async function catalogs(deps: ToolDeps): Promise<Catalog[]> {
  const data = await call(deps, 'list_team_product_catalogs', {});
  return (Array.isArray(data) ? data : []).flatMap(row =>
    isRecord(row) && typeof row.catalog_id === 'string' && typeof row.name === 'string'
      ? [
          {
            id: row.catalog_id,
            name: row.name,
            video: typeof row.video_name === 'string' ? row.video_name : null,
            folder: typeof row.folder_name === 'string' ? row.folder_name : null,
            products: typeof row.product_count === 'number' ? row.product_count : null,
            updatedAt: typeof row.last_updated_at === 'string' ? row.last_updated_at : null,
            error: typeof row.last_update_error === 'string' ? row.last_update_error : null,
            interval: typeof row.update_interval === 'string' ? row.update_interval : null
          }
        ]
      : []
  );
}

/** «всі», by name, by its video («каталоги тр16»), by folder, or the ones with an error. */
async function pickCatalogs(deps: ToolDeps, args: Args) {
  const all = await catalogs(deps);
  const names = list(args, 'items');
  const scope = fold(text(args, 'scope') ?? (names.length ? 'named' : 'all'));
  const inFolder = text(args, 'in_folder');
  const missing: string[] = [];
  let picked: Catalog[];
  if (names.length) {
    const found = new Map<string, Catalog>();
    for (const name of names) {
      const hits = all.filter(
        catalog =>
          fold(catalog.name) === fold(name) ||
          loose(catalog.name) === loose(name) ||
          (catalog.video !== null && loose(catalog.video) === loose(name))
      );
      if (!hits.length) missing.push(name);
      hits.forEach(hit => found.set(hit.id, hit));
    }
    picked = [...found.values()];
  } else picked = all;
  if (scope === 'errors' || scope === 'error') picked = picked.filter(catalog => catalog.error);
  if (inFolder)
    picked = picked.filter(catalog => catalog.folder && loose(catalog.folder) === loose(inFolder));
  return {
    picked: picked.sort((a, b) => naturally.compare(a.name, b.name)),
    missing,
    all: all.length
  };
}

async function listCatalogs(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const { picked, missing } = await pickCatalogs(deps, args);
  return {
    kind: 'table',
    payload: {
      tool: 'list_catalogs',
      columns: ['name', 'video', 'products', 'updated', 'error'],
      rows: picked
        .slice(0, TOOL_LIMITS.rows)
        .map(catalog => [
          catalog.name,
          catalog.video,
          catalog.products === null ? null : String(catalog.products),
          catalog.updatedAt,
          catalog.error
        ]),
      total: null,
      count: picked.length,
      missing,
      truncated: picked.length > TOOL_LIMITS.rows
    }
  };
}

/** «видали всі каталоги»: the exact list, into the Drive trash, only on the red button. */
async function trashCatalogs(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const { picked, missing } = await pickCatalogs(deps, args);
  if (!picked.length) throw new ToolRefusal('NOT_FOUND', missing.join(', ') || 'catalogs');
  if (picked.length > 500) throw new ToolRefusal('TOO_MANY', String(picked.length));
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'trash_catalogs',
      danger: true,
      items: picked.map(catalog => ({
        id: catalog.id,
        label: catalog.name,
        note: catalog.video
      })),
      missing
    }
  };
}

/** «онови каталоги тр16 зараз». */
async function updateCatalogs(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const { picked, missing } = await pickCatalogs(deps, args);
  if (!picked.length) throw new ToolRefusal('NOT_FOUND', missing.join(', ') || 'catalogs');
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'update_catalogs',
      items: picked.slice(0, 500).map(catalog => ({ id: catalog.id, label: catalog.name })),
      missing
    }
  };
}

// ───────────────────────── people ─────────────────────────

interface Person {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
}

async function people(deps: ToolDeps): Promise<{ list: Person[]; full: boolean }> {
  const members = await deps.callerRpc('list_team_members', { p_team: deps.teamId });
  if (!members.error && Array.isArray(members.data))
    return {
      full: true,
      list: members.data.flatMap(row =>
        isRecord(row) && typeof row.user_id === 'string'
          ? [
              {
                id: row.user_id,
                name: typeof row.display_name === 'string' ? row.display_name : '',
                email: typeof row.email === 'string' ? row.email : null,
                role: typeof row.role === 'string' ? row.role : null
              }
            ]
          : []
      )
    };
  const data = await call(deps, 'list_launch_assignees', {});
  return {
    full: false,
    list: (Array.isArray(data) ? data : []).flatMap(row =>
      isRecord(row) && typeof row.user_id === 'string'
        ? [
            {
              id: row.user_id,
              name: typeof row.display_name === 'string' ? row.display_name : '',
              email: null,
              role: null
            }
          ]
        : []
    )
  };
}

const SELF = ['me', 'myself', 'я', 'мене', 'мені', 'мною', 'собі', 'себе', 'сам', 'сама'];

function pickPerson(all: Person[], written: string, self: string): Person {
  const ref = fold(written).replace(/^@/u, '');
  if (SELF.includes(ref)) {
    const me = all.find(person => person.id === self);
    if (me) return me;
  }
  const exact = all.filter(
    person => fold(person.name) === ref || (person.email !== null && fold(person.email) === ref)
  );
  const found = exact.length
    ? exact
    : all.filter(
        person =>
          fold(person.name).split(/\s+/u).includes(ref) ||
          fold(person.name).startsWith(ref) ||
          (person.email !== null && fold(person.email).startsWith(`${ref}@`))
      );
  if (found.length === 1) return found[0]!;
  throw new ToolRefusal(found.length ? 'AMBIGUOUS_PERSON' : 'PERSON_NOT_FOUND', written);
}

async function listMembers(_args: Args, deps: ToolDeps): Promise<ToolCard> {
  const { list: all, full } = await people(deps);
  return {
    kind: 'table',
    payload: {
      tool: 'list_members',
      columns: full ? ['name', 'email', 'role'] : ['name'],
      rows: all.map(person => (full ? [person.name, person.email, person.role] : [person.name])),
      total: null,
      count: all.length,
      missing: [],
      truncated: false
    }
  };
}

const ROLES = ['admin', 'editor', 'viewer'];

/** «додай vasya@gmail.com редактором». The invitation e-mail goes out on the button. */
async function inviteMembers(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const emails = list(args, 'emails').map(email => email.toLowerCase());
  const role = fold(text(args, 'role') ?? 'editor');
  if (!ROLES.includes(role)) throw new ToolRefusal('INVALID_INPUT', role);
  if (!emails.length || emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)))
    throw new ToolRefusal('INVALID_EMAIL', emails.find(email => !email.includes('@')) ?? '');
  const { list: all } = await people(deps);
  const items = emails.slice(0, 20).map(email => ({
    label: email,
    email,
    member: all.some(person => person.email !== null && fold(person.email) === email)
  }));
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'invite_members',
      role,
      items: items.filter(i => !i.member),
      already: items.filter(i => i.member).map(i => i.email)
    }
  };
}

/** «зроби Андрія адміном», «прибери Санчоса з простору». */
async function changeMembers(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const { list: all, full } = await people(deps);
  if (!full) throw new ToolRefusal('PERMISSION_DENIED', '');
  const remove = args.get('remove') === true || fold(text(args, 'role') ?? '') === 'remove';
  const role = fold(text(args, 'role') ?? '');
  if (!remove && !ROLES.includes(role)) throw new ToolRefusal('INVALID_INPUT', role);
  const items = list(args, 'people').map(written => {
    const person = pickPerson(all, written, deps.userId);
    if (person.role === 'owner') throw new ToolRefusal('OWNER_TRANSFER_REQUIRED', person.name);
    return {
      id: person.id,
      label: person.name || person.email || written,
      from: person.role,
      to: remove ? null : role
    };
  });
  if (!items.length) throw new ToolRefusal('INVALID_INPUT', 'people');
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: remove ? 'remove_members' : 'change_roles',
      danger: remove,
      role: remove ? null : role,
      items
    }
  };
}

// ───────────────────────── tasks and tags ─────────────────────────

async function labels(deps: ToolDeps, scope: 'task' | 'agent') {
  const data = await call(deps, 'list_team_labels', { p_scope: scope });
  return (Array.isArray(data) ? data : []).flatMap(row =>
    isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string'
      ? [{ id: row.id, name: row.name }]
      : []
  );
}

function labelRefs(all: Array<{ id: string; name: string }>, written: string[]) {
  return written.map(name => {
    const clean = name.replace(/\s+/gu, ' ').trim();
    if (!clean || Array.from(clean).length > 24) throw new ToolRefusal('INVALID_NAME', name);
    const found = all.find(label => fold(label.name) === fold(clean));
    return found ? { id: found.id, name: found.name } : { id: null, name: clean };
  });
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  date: string | null;
  assignee: string | null;
  labels: string[];
  updatedAt: string;
}

async function tasks(deps: ToolDeps, args: Args): Promise<TaskRow[]> {
  const status = text(args, 'status');
  const data = await call(deps, 'list_team_tasks', {
    p_page_size: 100,
    ...(status && ['todo', 'in_progress', 'done'].includes(status) ? { p_status: status } : {})
  });
  return (Array.isArray(data) ? data : []).flatMap(row =>
    isRecord(row) && typeof row.id === 'string' && typeof row.title === 'string'
      ? [
          {
            id: row.id,
            title: row.title,
            status: typeof row.status === 'string' ? row.status : 'todo',
            date: typeof row.task_date === 'string' ? row.task_date : null,
            assignee:
              typeof row.assignee_label_snapshot === 'string' ? row.assignee_label_snapshot : null,
            labels: Array.isArray(row.labels)
              ? row.labels.flatMap(label =>
                  isRecord(label) && typeof label.name === 'string' ? [label.name] : []
                )
              : [],
            updatedAt: typeof row.updated_at === 'string' ? row.updated_at : ''
          }
        ]
      : []
  );
}

async function listTasks(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const all = await tasks(deps, args);
  const query = text(args, 'query');
  const assignee = text(args, 'assignee');
  const rows = all.filter(
    task =>
      (!query || fold(task.title).includes(fold(query))) &&
      (!assignee || (task.assignee !== null && fold(task.assignee).includes(fold(assignee))))
  );
  return {
    kind: 'table',
    payload: {
      tool: 'list_tasks',
      columns: ['title', 'status', 'date', 'assignee', 'tags'],
      rows: rows.map(task => [
        task.title,
        task.status,
        task.date,
        task.assignee,
        task.labels.join(', ') || null
      ]),
      total: null,
      count: rows.length,
      missing: [],
      truncated: all.length >= 100
    }
  };
}

/**
 * «заведи завдання "перезалити тр16" на Андрія на завтра з тегом срочно, прикріпи тр16».
 * Each task is one line «title | assignee | date | tags | files», written by the model.
 */
async function createTasks(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const lines = list(args, 'tasks');
  if (!lines.length || lines.length > 20) throw new ToolRefusal('INVALID_INPUT', 'tasks');
  const [{ list: all }, known] = await Promise.all([people(deps), labels(deps, 'task')]);
  const items = [];
  const missing: string[] = [];
  for (const line of lines) {
    const [title = '', who = '', when = '', tagText = '', files = ''] = line
      .split('|')
      .map(part => part.trim());
    const clean = title.replace(/\s+/gu, ' ');
    if (!clean || Array.from(clean).length > 160) throw new ToolRefusal('INVALID_NAME', title);
    const assignee = who ? pickPerson(all, who, deps.userId) : null;
    const date = when ? dayAny(deps, when) : null;
    const tags = labelRefs(known, tagText ? tagText.split(',') : []);
    const attach = files
      ? await pickMaterials(
          deps,
          new Map([
            [
              'items',
              files
                .split(',')
                .map(f => f.trim())
                .filter(Boolean)
            ]
          ]),
          null
        )
      : { items: [], missing: [] };
    missing.push(...attach.missing);
    items.push({
      label: clean,
      title: clean,
      assigneeId: assignee?.id ?? null,
      assignee: assignee?.name ?? null,
      date,
      tags,
      materials: attach.items.map(item => ({ id: item.id, label: item.name })),
      // What the card shows under the title: who, when, tags, files.
      note:
        [
          assignee?.name ?? null,
          date,
          ...tags.map(tag => `#${tag.name}`),
          ...attach.items.map(item => item.name)
        ]
          .filter(Boolean)
          .join(' · ') || null
    });
  }
  return { kind: 'review', payload: { purpose: 'tool', tool: 'create_tasks', items, missing } };
}

/** A task's day may be in the future, unlike a money day. */
function dayAny(deps: ToolDeps, written: string): string {
  const words: Record<string, number> = {
    today: 0,
    сьогодні: 0,
    tomorrow: 1,
    завтра: 1,
    yesterday: -1,
    вчора: -1,
    післязавтра: 2
  };
  const shift = words[fold(written)];
  const value = shift === undefined ? written : dayInZone(deps.now, deps.timezone, shift);
  if (!validFinanceDate(value)) throw new ToolRefusal('INVALID_DATE', written);
  return value;
}

/** «познач завдання тр16 як зроблене», «перенеси всі мої завдання на завтра». */
async function updateTasks(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const all = await tasks(deps, new Map());
  const names = list(args, 'items');
  const fromStatus = text(args, 'with_status');
  const status = text(args, 'status');
  const date = text(args, 'date');
  const who = text(args, 'assignee');
  if (status && !['todo', 'in_progress', 'done'].includes(status))
    throw new ToolRefusal('INVALID_INPUT', status);
  const [{ list: everyone }, known] = await Promise.all([people(deps), labels(deps, 'task')]);
  const assignee = who ? pickPerson(everyone, who, deps.userId) : null;
  const addTags = labelRefs(known, list(args, 'add_tags'));
  const missing: string[] = [];
  const picked = new Map<string, TaskRow>();
  for (const name of names) {
    const hits = all.filter(task => fold(task.title) === fold(name));
    const found = hits.length ? hits : all.filter(task => fold(task.title).includes(fold(name)));
    if (found.length === 1) picked.set(found[0]!.id, found[0]!);
    else missing.push(found.length ? `${name} (${found.length})` : name);
  }
  if (!names.length && fromStatus)
    all.filter(task => task.status === fromStatus).forEach(task => picked.set(task.id, task));
  const patchDate = date ? dayAny(deps, date) : null;
  const items = [...picked.values()].map(task => ({
    id: task.id,
    label: task.title,
    expectedUpdatedAt: task.updatedAt,
    // Only what changes, each part on its own — the window says it in the person's words.
    changes: [
      ...(status && status !== task.status
        ? [{ field: 'status', from: task.status, to: status }]
        : []),
      ...(patchDate && patchDate !== task.date
        ? [{ field: 'date', from: task.date, to: patchDate }]
        : []),
      ...(assignee && assignee.name !== task.assignee
        ? [{ field: 'assignee', from: task.assignee, to: assignee.name }]
        : []),
      ...(addTags.length
        ? [{ field: 'tags', from: null, to: addTags.map(tag => `#${tag.name}`).join(', ') }]
        : [])
    ],
    patch: {
      ...(status ? { status } : {}),
      ...(patchDate ? { dateOn: patchDate } : {}),
      ...(assignee ? { assigneeId: assignee.id } : {})
    },
    tags: addTags
  }));
  if (!items.length) throw new ToolRefusal('NOT_FOUND', missing.join(', ') || 'tasks');
  return { kind: 'review', payload: { purpose: 'tool', tool: 'update_tasks', items, missing } };
}

/** «створи тег #3 і повісь на g18-244 та g18-257», «зніми тег old з g4». */
async function tagAdAccounts(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const [agents, known] = await Promise.all([adAccounts(deps), labels(deps, 'agent')]);
  const add = labelRefs(known, list(args, 'add_tags'));
  const remove = labelRefs(known, list(args, 'remove_tags')).filter(tag => tag.id !== null);
  if (!add.length && !remove.length) throw new ToolRefusal('INVALID_INPUT', 'tags');
  const { picked, missing } = pickAdAccounts(agents, list(args, 'scope'));
  if (!picked.length) throw new ToolRefusal('NOT_FOUND', missing.join(', ') || 'scope');
  const items = picked
    .map(agent => {
      const has = new Set(agent.tags.map(fold));
      const adding = add.filter(tag => !has.has(fold(tag.name)));
      const removing = remove.filter(tag => has.has(fold(tag.name)));
      return {
        id: agent.id,
        label: agent.label,
        from: agent.tags.join(', ') || null,
        to:
          [
            ...agent.tags.filter(tag => !removing.some(r => fold(r.name) === fold(tag))),
            ...adding.map(tag => tag.name)
          ].join(', ') || null,
        add: adding,
        remove: removing
      };
    })
    .filter(item => item.add.length || item.remove.length);
  if (!items.length) throw new ToolRefusal('NOTHING_TO_CHANGE', '');
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'tag_ad_accounts',
      items,
      created: add.filter(tag => tag.id === null).map(tag => tag.name),
      missing
    }
  };
}

/** «видали завдання X», «прибери всі зроблені завдання». */
async function deleteTasks(args: Args, deps: ToolDeps): Promise<ToolCard> {
  const all = await tasks(deps, new Map());
  const names = list(args, 'items');
  const withStatus = text(args, 'with_status');
  const missing: string[] = [];
  const picked = new Map<string, TaskRow>();
  for (const name of names) {
    const hits = all.filter(task => fold(task.title) === fold(name));
    const found = hits.length ? hits : all.filter(task => fold(task.title).includes(fold(name)));
    if (found.length === 1) picked.set(found[0]!.id, found[0]!);
    else missing.push(found.length ? `${name} (${found.length})` : name);
  }
  if (!names.length && withStatus)
    all.filter(task => task.status === withStatus).forEach(task => picked.set(task.id, task));
  if (!picked.size) throw new ToolRefusal('NOT_FOUND', missing.join(', ') || 'tasks');
  return {
    kind: 'review',
    payload: {
      purpose: 'tool',
      tool: 'delete_tasks',
      danger: true,
      items: [...picked.values()].map(task => ({
        id: task.id,
        label: task.title,
        note: [task.date, task.assignee].filter(Boolean).join(' · ') || null
      })),
      missing
    }
  };
}

/** After a rename card, the names it gives point back to the files, for the steps after it. */
export function rememberRenames(card: ToolCard, renamed: Map<string, string>): void {
  if (card.kind !== 'review' || card.payload.tool !== 'rename_materials') return;
  for (const item of (card.payload.items as Array<{ from?: string; to?: string }>) ?? [])
    if (item.from && item.to) renamed.set(loose(item.to), item.from);
}

interface Tool {
  kind: 'read' | 'write';
  run: (args: Args, deps: ToolDeps) => Promise<ToolCard>;
}

export const TOOLS: Record<string, Tool> = {
  finance_report: { kind: 'read', run: financeReport },
  topup_statement: { kind: 'read', run: topupStatement },
  set_finance: { kind: 'write', run: setFinance },
  tag_ad_accounts: { kind: 'write', run: tagAdAccounts },
  find_materials: { kind: 'read', run: findMaterials },
  create_folders: { kind: 'write', run: createFolders },
  move_materials: { kind: 'write', run: moveMaterials },
  rename_materials: { kind: 'write', run: renameMaterials },
  edit_materials: { kind: 'write', run: editMaterials },
  trash_materials: { kind: 'write', run: trashMaterials },
  list_catalogs: { kind: 'read', run: listCatalogs },
  trash_catalogs: { kind: 'write', run: trashCatalogs },
  update_catalogs: { kind: 'write', run: updateCatalogs },
  list_members: { kind: 'read', run: listMembers },
  invite_members: { kind: 'write', run: inviteMembers },
  change_members: { kind: 'write', run: changeMembers },
  list_tasks: { kind: 'read', run: listTasks },
  create_tasks: { kind: 'write', run: createTasks },
  update_tasks: { kind: 'write', run: updateTasks },
  delete_tasks: { kind: 'write', run: deleteTasks }
};

/** The tool names the model may write, with one line each for its prompt. */
export const TOOL_GUIDE = [
  'finance_report — money of ad accounts: «скільки витрат за вчора», «поповнення за тиждень по акаунтах». args: from, to (YYYY-MM-DD, or date for one day), by (total|account|ad_account|tag|day), scope (optional list of ad accounts/accounts/tags «tag:#2»).',
  'topup_statement — a statement of top-ups for a period grouped by tags (by: tag) or by accounts (by: account), with text to copy. args: from, to, by, scope.',
  'set_finance — record money for a day: «простав поповнення 100 на g18-244 і 50 на g18-257». args: metric (topup|spend|balance), date, entries (["g18-244=100","g18-257=50"]) or amount + scope (the same sum for each).',
  'tag_ad_accounts — tags on ad accounts, creating missing tags: args: scope (ad accounts/accounts/tags), add_tags, remove_tags.',
  'find_materials — find files/creatives: args: items (names), or query, kind (video|image|folder|…), in_folder, tag, offer, geo.',
  'create_folders — args: names, parent (folder name or path; omit for the root).',
  'move_materials — move files (not folders: Soty moves files only) into a folder (made if missing): args: items or query/kind/in_folder/tag/offer/geo, destination (folder name or path), parent (where a new destination goes).',
  'rename_materials — rename many files: args: pairs (["тр16=TR_16_final"]), or a selection (items/query/kind/in_folder…) with one rule: prefix, suffix, find+replace, or template with {n} {name} {offer} {geo} and start.',
  'edit_materials — tags and fields of files: args: selection, add_tags, remove_tags, set_offer, set_geo.',
  'trash_materials — delete files/folders into the Drive trash: args: selection (items or query/kind/in_folder/tag/offer/geo).',
  'list_catalogs — product catalogs: args: items (names or video names), scope (all|errors), in_folder.',
  'trash_catalogs — delete catalogs into the Drive trash: «видали всі каталоги» → scope all; or items; scope errors; in_folder.',
  'update_catalogs — refresh catalogs now: same selection as trash_catalogs.',
  'list_members — the people of the space.',
  'invite_members — args: emails, role (admin|editor|viewer; default editor).',
  'change_members — args: people (names or emails), role (admin|editor|viewer) or remove true.',
  'list_tasks — args: status (todo|in_progress|done), query, assignee.',
  'create_tasks — args: tasks, each one line «title | assignee | date | tag1, tag2 | file1, file2» (empty parts stay empty; date YYYY-MM-DD or tomorrow).',
  'update_tasks — args: items (task titles) or with_status (todo|in_progress|done), and status, date, assignee, add_tags.',
  'delete_tasks — delete tasks: args: items (task titles) or with_status (todo|in_progress|done).'
].join('\n');

/** One tool step of a plan → its card; a refusal becomes the same «не вийшло» card as elsewhere. */
export async function runTool(
  tool: string,
  args: AssistantToolArg[],
  deps: ToolDeps
): Promise<ToolCard> {
  const found = TOOLS[tool];
  if (!found) return problem(tool, 'UNKNOWN_TOOL', tool);
  try {
    return await found.run(argMap(args), deps);
  } catch (error) {
    if (error instanceof ToolRefusal) return problem(tool, error.code, error.written);
    throw error;
  }
}

function problem(tool: string, code: string, written: string): ToolCard {
  return {
    kind: 'result',
    payload: {
      rows: [],
      differences: [],
      unresolved: [{ field: tool, written, code }],
      profile: null,
      campaigns: 0,
      date: null
    }
  };
}
