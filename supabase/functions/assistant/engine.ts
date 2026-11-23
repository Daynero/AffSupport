/**
 * The launch assistant's executor (064). Pure apart from the injected RPC callers.
 *
 * A checked plan becomes ordinary drafts through the existing commands, called with the person's
 * own token (their rights, their request keys). Every reference is resolved before the first
 * write: an ambiguous one becomes a question and nothing is written; a missing one is reported
 * and the unambiguous rest is saved. Every write is keyed, recorded as an effect for «Скасувати»,
 * and described by a card the server builds from the stored rows.
 */
// @deno-types="../../../packages/shared/dist/team/assistant.d.ts"
import {
  assistantKey,
  assistantNumber,
  ASSISTANT_MAX_CAMPAIGNS,
  ASSISTANT_MAX_DRAFTS,
  assistantUrlSlot,
  matchAssistantName,
  type AssistantAction,
  type AssistantCandidate,
  type AssistantFieldChange,
  type AssistantPlan,
  type AssistantRow
} from '../../../packages/shared/dist/team/assistant.js';
// @deno-types="../../../packages/shared/dist/team/assistant-apply.d.ts"
import {
  applyAssistantChange,
  assistantBlockedFields,
  type ResolvedMaterial
} from '../../../packages/shared/dist/team/assistant-apply.js';
// @deno-types="../../../packages/shared/dist/team/launches/defaults-merge.d.ts"
import {
  isLaunchDefaultPath,
  launchDayInZone,
  newDraftFromDefaults,
  readLaunchPath,
  type LaunchDefaultPath,
  type LaunchDefaultsProfile
} from '../../../packages/shared/dist/team/launches/defaults-merge.js';
// @deno-types="../../../packages/shared/dist/team/launches/fields.d.ts"
import { launchField } from '../../../packages/shared/dist/team/launches/fields.js';
import { rememberRenames, runTool } from './tools.ts';
import type { Rpc } from '../_shared/ai-allowance.ts';
import { isRecord } from '../_shared/validation.ts';

type Draft = Record<string, unknown>;

export interface EngineDeps {
  userId: string;
  teamId: string;
  commandId: string;
  callerRpc: Rpc;
  serviceRpc: Rpc;
  now: Date;
  timezone: string;
  urls: string[];
  /** Answers already given to questions of this command: written reference → id. */
  choices: Record<string, string>;
  /** Rows of the card the person is looking at, by 1-based position. */
  shown: AssistantRow[];
  /** Translates notes (a second model call); absent where no model is available. */
  translateNotes?: (notes: NoteText[], language: string) => Promise<NoteText[] | null>;
  /**
   * What the person wrote in this dialog (this message and the requests before it). An offer or
   * an account is created without a button only under a name the person wrote: a name the model
   * read in the space's data (a file, a note, a task) must never create anything by itself.
   * Absent for plans stored before this rule; then nothing is checked.
   */
  said?: string | null;
}

const GENERIC_OFFER_WORDS = new Set([
  'новий',
  'нова',
  'нове',
  'новий_офер',
  'офер',
  'оффер',
  'офр',
  'тестовий',
  'тест',
  'якийсь',
  'new',
  'offer',
  'test',
  'my',
  'мій',
  'назва',
  'name',
  'untitled',
  'без',
  'назви'
]);

/**
 * Whether the person wrote this name themselves (spelling, case and spaces aside). An offer's
 * country code is the model's reading of the person's words («прокапс на мексику» → ProCaps MX),
 * so for an offer the product is what has to be written.
 */
function personSaid(deps: EngineDeps, name: string, offer = false): boolean {
  if (deps.said === undefined || deps.said === null) return true;
  const product = offer ? name.trim().replace(/\s+[A-Za-z]{2,3}$/u, '') : name;
  // «створи новий офер, назву придумай сам» → «Новий офер»: words of the request are not a name
  // the person gave (found on next 1.6.0). Such a name is asked about, as any the model chose.
  if (
    offer &&
    product
      .toLocaleLowerCase('uk')
      .split(/[\s_-]+/u)
      .filter(Boolean)
      .every(word => GENERIC_OFFER_WORDS.has(word))
  )
    return false;
  // «флексі» is Flexi: x reads as ks in both.
  const fold = (text: string) => assistantKey(text).replace(/x/gu, 'ks');
  const key = fold(product);
  return key.length > 0 && fold(deps.said).includes(key);
}

export interface NoteText {
  title: string;
  text: string;
}

interface LaunchNoteValue extends NoteText {
  id: string;
  color?: string | null;
}

export interface Card {
  kind: 'result' | 'question' | 'review' | 'profile' | 'refusal' | 'status' | 'table';
  payload: Record<string, unknown>;
}

export type EngineOutcome =
  | { kind: 'question'; card: Card; pending: { ref: RefKey; options: AssistantCandidate[] } }
  | { kind: 'done'; cards: Card[]; status: 'done' | 'partial'; deferred: AssistantAction[] }
  | { kind: 'rejected'; code: string };

type RefKind = 'offer' | 'buyer' | 'account' | 'material';
export type RefKey = `${RefKind}:${string}`;

interface AgentCandidate extends AssistantCandidate {
  /** The account (social) name people write: «g4». */
  account: string;
  /** As the launch list shows it: «g4-257». */
  label: string;
  free: boolean;
  /** Launches currently on it; the least loaded is taken when none is free. */
  load: number;
  /** Assignments from before 053 that must be reconciled in Accounts first. */
  legacy?: number;
  /** Manual marks on it, which a release clears too. */
  runs?: number;
}

interface Names {
  offers: AssistantCandidate[];
  buyers: AssistantCandidate[];
  accounts: AgentCandidate[];
}

class EngineRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function rpcCode(error: { message?: string; code?: string } | null): string {
  const text = `${error?.message ?? ''} ${error?.code ?? ''}`;
  return text.match(/[A-Z][A-Z0-9_]{3,}/u)?.[0] ?? 'UNAVAILABLE';
}

async function call(rpc: Rpc, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc(name, args);
  if (error) throw new EngineRefusal(rpcCode(error));
  return data;
}

export async function loadNames(deps: Pick<EngineDeps, 'callerRpc' | 'teamId'>): Promise<Names> {
  const dictionaries = await call(deps.callerRpc, 'list_launch_dictionaries', {
    p_team: deps.teamId
  });
  const rows = (value: unknown): AssistantCandidate[] =>
    Array.isArray(value)
      ? value.flatMap(item =>
          isRecord(item) &&
          typeof item.id === 'string' &&
          typeof item.value === 'string' &&
          !item.archivedAt &&
          !item.archived_at
            ? [{ id: item.id, name: item.value }]
            : []
        )
      : [];
  const accounts = await call(deps.callerRpc, 'list_team_accounts', { p_team: deps.teamId });
  const agents: AgentCandidate[] = [];
  if (Array.isArray(accounts)) {
    for (const account of accounts) {
      if (!isRecord(account) || !Array.isArray(account.agents)) continue;
      const accountName = typeof account.name === 'string' ? account.name.trim() : '';
      for (const agent of account.agents) {
        if (
          isRecord(agent) &&
          typeof agent.id === 'string' &&
          typeof agent.agent_id === 'string' &&
          !agent.archived_at
        ) {
          const availability = isRecord(agent.availability) ? agent.availability : {};
          const label = accountName ? `${accountName}-${agent.agent_id.slice(-3)}` : agent.agent_id;
          agents.push({
            id: agent.id,
            name: label,
            account: accountName,
            label,
            free: availability.status === 'free',
            load:
              typeof availability.assignmentCount === 'number' ? availability.assignmentCount : 0,
            legacy: typeof availability.legacyCount === 'number' ? availability.legacyCount : 0,
            runs: Array.isArray(agent.runs) ? agent.runs.length : 0
          });
        }
      }
    }
  }
  const dict = isRecord(dictionaries) ? dictionaries : {};
  return { offers: rows(dict.offers), buyers: rows(dict.buyers), accounts: agents };
}

async function searchMaterials(deps: EngineDeps, written: string): Promise<AssistantCandidate[]> {
  const found = new Map<string, AssistantCandidate & { kind: 'video' | 'image' }>();
  const queries = [written.trim(), written.replace(/[^0-9]+/gu, ' ').trim()].filter(Boolean);
  for (const query of [...new Set(queries)].slice(0, 2)) {
    const data = await call(deps.callerRpc, 'search_materials', {
      p_team: deps.teamId,
      p_query: query,
      p_filters: {},
      p_page: 1,
      p_page_size: 50
    });
    const items = isRecord(data) && Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
      const mime =
        typeof item.mime_type === 'string'
          ? item.mime_type
          : typeof item.mimeType === 'string'
            ? item.mimeType
            : '';
      const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null;
      const alias = materialAlias(item.name);
      if (kind && alias)
        found.set(item.id, { id: item.id, name: alias, kind, file: item.name } as never);
    }
  }
  return [...found.values()];
}

/**
 * An ad account as people write it: the list label «g4-257», the full ID, or the account name
 * «g4». A name with several ad accounts takes the free one; several free ones take the first in
 * the list order; none free — the person chooses.
 */
function pickAgent(
  written: string,
  agents: readonly AgentCandidate[]
):
  | { kind: 'one'; candidate: AgentCandidate }
  | { kind: 'many'; candidates: AgentCandidate[] }
  | { kind: 'none' } {
  const key = assistantKey(written);
  if (!key) return { kind: 'none' };
  const exact = agents.filter(
    agent => assistantKey(agent.label) === key || assistantKey(agent.id) === key
  );
  if (exact.length === 1) return { kind: 'one', candidate: exact[0]! };
  const byId = agents.filter(
    agent => agent.label.endsWith(written.trim()) || assistantKey(agent.name).endsWith(key)
  );
  const ofAccount = agents.filter(agent => agent.account && assistantKey(agent.account) === key);
  const pool = ofAccount.length ? ofAccount : exact.length ? exact : byId.length === 1 ? byId : [];
  if (pool.length === 0) return { kind: 'none' };
  if (pool.length === 1) return { kind: 'one', candidate: pool[0]! };
  // An account written without its ad account: a free one, else the least loaded — the card shows
  // which, and «на g18-244» changes it. Asking here only slowed every batch down.
  if (ofAccount.length > 1) {
    const ranked = [...pool].sort(
      (a, b) => Number(b.free) - Number(a.free) || a.load - b.load || a.label.localeCompare(b.label)
    );
    return { kind: 'one', candidate: ranked[0]! };
  }
  const free = pool.filter(agent => agent.free);
  if (free.length >= 1) return { kind: 'one', candidate: free[0]! };
  return { kind: 'many', candidates: pool.slice(0, 5) };
}

/** «g4» names the account of «g4-257»; the full label names that ad account. */
function sameAccount(written: string, label: string): boolean {
  const key = assistantKey(written);
  // The account is the label without its last «-NNN»: «g18-old-244» belongs to «g18-old», never
  // to «g18» (the first dash cut it there before).
  return (
    Boolean(key) &&
    (assistantKey(label) === key || assistantKey(label.replace(/-[^-]+$/u, '')) === key)
  );
}

/** «TR_17 restitched.mp4» → «TR_17»: the alias people say; generated catalog files are not creatives. */
function materialAlias(name: string): string | null {
  if (/^catalog_variant_/iu.test(name)) return null;
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/u, '');
  const token = /^([A-Za-zА-Яа-яІіЇїЄєҐґ]{1,6})[ _-]?(\d{1,4})(?!\d)/u.exec(stem);
  return token ? `${token[1]}_${token[2]}` : stem;
}

/** Every reference of the plan, in order of first appearance. */
function references(plan: AssistantPlan): RefKey[] {
  const refs: RefKey[] = [];
  const add = (key: RefKey) => {
    if (!refs.includes(key)) refs.push(key);
  };
  const fields = (changes: AssistantFieldChange[]) => {
    for (const change of changes) {
      if (change.field === 'buyerId' && typeof change.value === 'string')
        add(`buyer:${change.value}`);
      if (change.field === 'agentRowId' && typeof change.value === 'string')
        add(`account:${change.value}`);
      if (change.field === 'offerId' && typeof change.value === 'string')
        add(`offer:${change.value}`);
      if (change.field === 'creatives') {
        const list = Array.isArray(change.value) ? change.value : [change.value];
        for (const item of list) if (typeof item === 'string') add(`material:${item}`);
      }
    }
  };
  for (const action of plan.actions) {
    if (action.offer) add(`offer:${action.offer}`);
    if (action.notesFrom) add(`offer:${action.notesFrom}`);
    if (action.type !== 'create_account' && action.type !== 'release_accounts')
      for (const account of action.accounts) add(`account:${account}`);
    fields(action.fields);
    for (const override of action.overrides) {
      add(`account:${override.account}`);
      fields(override.fields);
    }
  }
  return refs;
}

export interface Resolution {
  ids: Map<RefKey, string>;
  names: Map<string, string>;
  materials: Map<string, ResolvedMaterial>;
  /** «g18*free» → every free ad account of g18, «g18*all», «*free»: expanded by Soty. */
  expansions: Map<string, AgentCandidate[]>;
  missing: Array<{ field: string; written: string; code: string }>;
  /** Offers this command created, as named. */
  createdOffers: string[];
  /** A filter's offer that names several («прокапс» → ProCaps TR and ProCaps BG): all of them. */
  offerSets: Map<string, string[]>;
  /** «*any», «g18*any»: ad accounts to take one by one, free first, then the least loaded. */
  pools: Map<string, AgentCandidate[]>;
  /** Accounts this command created, with the ad accounts added to them. */
  createdAccounts: Array<{ name: string; agents: string[] }>;
  /** Offers of the space, for notes taken from another offer. */
  offerList: AssistantCandidate[];
  /** Notes each action carries from another offer, read and translated once. */
  notes: Map<string, LaunchNoteValue[] | null>;
}

/** Answers of the «no such offer» question. */
export const NEW_OFFER = 'new-offer';
export const NO_OFFER = 'no-offer';

/** An offer a command needs to exist: one it creates drafts on, saves defaults for, or creates. */
function offerWanted(plan: AssistantPlan, written: string): boolean {
  return plan.actions.some(
    action =>
      (action.offer === written &&
        (action.type === 'create_drafts' ||
          action.type === 'save_offer_defaults' ||
          action.type === 'create_offer')) ||
      (action.type === 'update_fields' &&
        action.fields.some(change => change.field === 'offerId' && change.value === written))
  );
}

async function createOffer(deps: EngineDeps, written: string, n: number): Promise<string> {
  const data = await call(deps.callerRpc, 'create_launch_dictionary', {
    p_team: deps.teamId,
    p_kind: 'offers',
    p_value: written.trim().replace(/\s+/gu, ' ').slice(0, 160),
    p_request_key: requestKey(deps, 900, `offer${n}`)
  });
  if (!isRecord(data) || typeof data.id !== 'string') throw new EngineRefusal('UNAVAILABLE');
  return data.id;
}

/** Creatives written as a bare number with an offer: «21», «21й відос» → 21. */
function creativeNumbers(plan: AssistantPlan, offer: string): number[] {
  const numbers = new Set<number>();
  for (const action of plan.actions) {
    if (action.offer !== offer) continue;
    for (const change of action.fields) {
      if (change.field !== 'creatives') continue;
      for (const item of Array.isArray(change.value) ? change.value : [change.value]) {
        if (typeof item === 'number') numbers.add(item);
        else if (typeof item === 'string' && /^[0-9]+$/u.test(assistantKey(item)))
          numbers.add(Number(assistantKey(item)));
      }
    }
  }
  return [...numbers].slice(0, 5);
}

/** The one country code of the creatives given with an offer: «тр25», «TR_23» → TR. */
function creativeGeo(plan: AssistantPlan, offer: string): string | null {
  const geos = new Set<string>();
  for (const action of plan.actions) {
    if (action.offer !== offer) continue;
    for (const change of action.fields) {
      if (change.field !== 'creatives') continue;
      for (const item of Array.isArray(change.value) ? change.value : [change.value]) {
        if (typeof item !== 'string') continue;
        const letters = /^([a-z]{2,3})[0-9]+$/u.exec(assistantKey(item))?.[1];
        if (letters) geos.add(letters.toUpperCase());
      }
    }
  }
  return geos.size === 1 ? [...geos][0]! : null;
}

/**
 * An account and its ad accounts, written «g20#4371698153094046». An account that exists takes
 * the new ad accounts; an ad account already there is reported, not added twice.
 */
async function createAccounts(
  action: AssistantAction,
  deps: EngineDeps,
  names: Names,
  resolution: Resolution
): Promise<void> {
  const wanted = new Map<string, string[]>();
  for (const entry of action.accounts) {
    const [rawName, ...ids] = entry.split('#');
    const name = (rawName ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!name || name.length > 80 || /[[\]]/u.test(name)) {
      resolution.missing.push({ field: 'account', written: entry, code: 'INVALID_VALUE' });
      continue;
    }
    const list = wanted.get(name) ?? [];
    for (const id of ids.join('#').split(/[\s,#]+/u)) if (id) list.push(id);
    wanted.set(name, list);
  }
  for (const [name, ids] of wanted) {
    const existing = names.accounts.find(
      agent => assistantKey(agent.account) === assistantKey(name)
    );
    // Created without a button, so only what the person wrote: a new account by its name, an ad
    // account by its id (review 2026-11-22 — names from the space reach the model's prompt).
    const unsaid = [...(existing ? [] : [name]), ...ids].find(value => !personSaid(deps, value));
    if (unsaid !== undefined) {
      resolution.missing.push({ field: 'account', written: unsaid, code: 'NOT_SAID' });
      continue;
    }
    let accountId = existing ? await accountIdOf(deps, name) : null;
    const created: string[] = [];
    try {
      if (!accountId) {
        const row = await call(deps.callerRpc, 'create_team_account', {
          p_team: deps.teamId,
          p_name: name,
          p_timezone: deps.timezone
        });
        accountId = isRecord(row) && typeof row.id === 'string' ? row.id : null;
        if (!accountId) throw new EngineRefusal('UNAVAILABLE');
      }
      for (const agentId of ids) {
        const added = await deps.callerRpc('add_team_account_agent', {
          p_team: deps.teamId,
          p_account: accountId,
          p_agent_id: agentId,
          p_note: null,
          p_timezone: deps.timezone
        });
        const rowId =
          !added.error && isRecord(added.data) && typeof added.data.id === 'string'
            ? added.data.id
            : null;
        if (!rowId) {
          // Already in the space, or refused: said for this ad account, the rest go on.
          resolution.missing.push({
            field: 'account',
            written: agentId,
            code: added.error ? rpcCode(added.error) : 'UNAVAILABLE'
          });
          continue;
        }
        const label = `${name}-${agentId.slice(-3)}`;
        names.accounts.push({ id: rowId, name: label, account: name, label, free: true, load: 0 });
        created.push(label);
      }
    } catch (error) {
      if (!(error instanceof EngineRefusal)) throw error;
      resolution.missing.push({
        field: 'account',
        written: name,
        code: error.code === 'PERMISSION_DENIED' ? 'ACCOUNT_CREATE_FORBIDDEN' : error.code
      });
      continue;
    }
    resolution.createdAccounts.push({ name, agents: created });
  }
}

async function accountIdOf(deps: EngineDeps, name: string): Promise<string | null> {
  const accounts = await call(deps.callerRpc, 'list_team_accounts', { p_team: deps.teamId });
  if (!Array.isArray(accounts)) return null;
  const found = accounts.find(
    account =>
      isRecord(account) &&
      typeof account.name === 'string' &&
      assistantKey(account.name) === assistantKey(name)
  );
  return isRecord(found) && typeof found.id === 'string' ? found.id : null;
}

/**
 * The notes an action takes from another offer («тайтл як у Туреччині»): that offer's default
 * notes, translated when a language is named. Read once per action; a failure is reported and the
 * rest of the action goes on without notes.
 */
async function actionNotes(
  action: AssistantAction,
  deps: EngineDeps,
  resolution: Resolution,
  problems: Array<{ field: string; written: string; code: string }>
): Promise<LaunchNoteValue[] | null> {
  if (!action.notesFrom) return null;
  // The same notes in the same language are read and translated once per command.
  const cacheKey = `${action.notesFrom}|${action.notesLanguage ?? ''}`;
  if (resolution.notes.has(cacheKey)) return resolution.notes.get(cacheKey) ?? null;
  const settle = (value: LaunchNoteValue[] | null, code?: string) => {
    if (code) problems.push({ field: 'notes', written: action.notesFrom ?? '', code });
    resolution.notes.set(cacheKey, value);
    return value;
  };
  const sourceId = resolution.ids.get(`offer:${action.notesFrom}`);
  if (!sourceId) return settle(null, 'NOTES_NOT_FOUND');
  const profile = await call(deps.callerRpc, 'get_launch_offer_defaults', {
    p_team: deps.teamId,
    p_offer: sourceId
  });
  const config = isRecord(profile) && isRecord(profile.config) ? profile.config : {};
  const source = Array.isArray(config.notes)
    ? (config.notes as unknown[]).flatMap(note =>
        isRecord(note) && typeof note.text === 'string'
          ? [
              {
                title: typeof note.title === 'string' ? note.title : '',
                text: note.text,
                color: typeof note.color === 'string' ? note.color : null
              }
            ]
          : []
      )
    : [];
  if (source.length === 0) return settle(null, 'NOTES_NOT_FOUND');
  let texts: NoteText[] = source.map(note => ({ title: note.title, text: note.text }));
  if (action.notesLanguage) {
    const translated = deps.translateNotes
      ? await deps.translateNotes(texts, action.notesLanguage)
      : null;
    if (!translated) return settle(null, 'NOTES_TRANSLATE_FAILED');
    texts = translated;
  }
  return settle(
    texts.map((note, index) => ({
      id: crypto.randomUUID(),
      title: note.title,
      text: note.text,
      ...(source[index]?.color ? { color: source[index]!.color } : {})
    }))
  );
}

/**
 * «звільни всі РК», «звільни g18», «звільни g18-244»: the busy ad accounts of the selection, with
 * how many launches and manual marks each holds. Only a card — the person releases them with its
 * button, through the same release as the Accounts tab.
 */
async function releaseCard(action: AssistantAction, deps: EngineDeps): Promise<Card> {
  const names = await loadNames(deps);
  const wanted = action.accounts.map(entry => entry.split('*')[0]!.trim()).filter(Boolean);
  const picked = names.accounts.filter(
    agent =>
      wanted.length === 0 ||
      wanted.some(
        written =>
          assistantKey(written) === assistantKey(agent.label) ||
          assistantKey(written) === assistantKey(agent.account)
      )
  );
  const busy = picked.filter(agent => agent.load > 0 || (agent.runs ?? 0) > 0);
  return {
    kind: 'review',
    payload: {
      purpose: 'release',
      agents: busy.map(agent => ({
        agentRowId: agent.id,
        label: agent.label,
        launches: agent.load,
        runs: agent.runs ?? 0,
        legacy: agent.legacy ?? 0
      })),
      checked: picked.length,
      rows: []
    }
  };
}

/** Each draft gets the notes with ids of its own. */
function freshNotes(notes: LaunchNoteValue[]): LaunchNoteValue[] {
  return notes.map(note => ({ ...note, id: crypto.randomUUID() }));
}

/** Country codes that end the offers a plan names: «Urafirin MY» → MY. */
function planGeos(plan: AssistantPlan, names: Names, resolution?: Resolution): string[] {
  const geos = new Set<string>();
  for (const action of plan.actions) {
    if (!action.offer) continue;
    // The offer as resolved (after a question or by its creatives), else as matched by name.
    const resolvedId = resolution?.ids.get(`offer:${action.offer}`);
    const found = matchAssistantName(action.offer, names.offers);
    const name =
      (resolvedId ? resolution?.names.get(resolvedId) : undefined) ??
      (found.kind === 'one' ? found.candidate.name : action.offer);
    const geo = /(?:^|\s)([A-Za-z]{2,3})$/u.exec(name.trim())?.[1];
    if (geo) geos.add(geo.toUpperCase());
  }
  return [...geos].slice(0, 4);
}

/** Resolves every reference, or returns the first ambiguous one as a question. */
export async function resolvePlan(
  plan: AssistantPlan,
  deps: EngineDeps,
  names: Names
): Promise<
  { ok: true; resolution: Resolution } | { ok: false; ref: RefKey; options: AssistantCandidate[] }
> {
  const resolution: Resolution = {
    expansions: new Map(),
    ids: new Map(),
    names: new Map(),
    materials: new Map(),
    missing: [],
    createdOffers: [],
    offerSets: new Map(),
    pools: new Map(),
    createdAccounts: [],
    offerList: names.offers,
    notes: new Map()
  };
  // «створи g20 з РК 4371…»: the account and its ad accounts exist before anything refers to them.
  for (const action of plan.actions) {
    if (action.type !== 'create_account') continue;
    await createAccounts(action, deps, names, resolution);
  }
  // The model sometimes names a new draft's offer as an offerId field instead of the action's
  // offer: it is the same offer, resolved — and asked about — the same way. Idempotent.
  for (const action of plan.actions) {
    if (action.type !== 'create_drafts' || action.offer) continue;
    const named = action.fields.find(
      change =>
        change.field === 'offerId' && change.op === 'set' && typeof change.value === 'string'
    );
    if (!named) continue;
    action.offer = named.value as string;
    action.fields = action.fields.filter(change => change !== named);
  }
  for (const ref of references(plan)) {
    const [kind, ...rest] = ref.split(':') as [RefKind, ...string[]];
    const written = rest.join(':');
    const chosen = deps.choices[ref];
    const pool =
      kind === 'offer'
        ? names.offers
        : kind === 'buyer'
          ? names.buyers
          : kind === 'account'
            ? names.accounts
            : null;
    if (kind === 'material') {
      const candidates = await searchMaterials(deps, written);
      let match = chosen
        ? candidates.find(c => c.id === chosen)
        : (() => {
            const result = matchAssistantName(written, candidates);
            if (result.kind === 'many') {
              // «21» next to ProCaps TR is TR_21 even when BG_21 exists too.
              const geos = planGeos(plan, names, resolution);
              const ofOffer = result.candidates.filter(c =>
                geos.some(geo => assistantKey(c.name).startsWith(geo.toLowerCase()))
              );
              if (ofOffer.length === 1) return ofOffer[0]!;
              const plain = result.candidates.filter(c => {
                const file = (c as AssistantCandidate & { file?: string }).file ?? c.name;
                return (
                  assistantKey(file.replace(/\.[A-Za-z0-9]{1,5}$/u, '')) === assistantKey(c.name)
                );
              });
              if (plain.length === 1) return plain[0]!;
              return result.candidates.map(c => ({
                id: c.id,
                name: (c as AssistantCandidate & { file?: string }).file ?? c.name
              }));
            }
            return result.kind === 'one' ? result.candidate : null;
          })();
      if (Array.isArray(match)) return { ok: false, ref, options: match };
      if (!match) {
        // «май1» next to «Urafirin MY» is MY_1: creatives are named by the offer's country code.
        const number = assistantNumber(written);
        for (const geo of number === null ? [] : planGeos(plan, names, resolution)) {
          const guess = `${geo}_${number}`;
          const result = matchAssistantName(guess, await searchMaterials(deps, guess));
          if (result.kind === 'one') {
            match = result.candidate;
            break;
          }
        }
      }
      if (!match) {
        resolution.missing.push({ field: 'creatives', written, code: 'MATERIAL_NOT_FOUND' });
        continue;
      }
      const kindOf = (match as AssistantCandidate & { kind?: 'video' | 'image' }).kind ?? 'video';
      resolution.ids.set(ref, match.id);
      const file = (match as AssistantCandidate & { file?: string }).file ?? match.name;
      resolution.names.set(match.id, file);
      resolution.materials.set(written, { materialId: match.id, name: file, kind: kindOf });
      continue;
    }
    const candidates = pool ?? [];
    let id: string | null = null;
    if (chosen && candidates.some(c => c.id === chosen)) id = chosen;
    else if (kind === 'account' && written.includes('*')) {
      const [account, which] = written.split('*') as [string, string];
      const key = assistantKey(account);
      const pool = names.accounts.filter(agent => !key || assistantKey(agent.account) === key);
      // «на будь-якому вільному»: one ad account, not one launch per free one. Written as a
      // field (the account of a shown draft), «*free» means the same.
      const single =
        which === 'any' || !plan.actions.some(action => action.accounts.includes(written));
      if (single) {
        const ranked = [...pool].sort(
          (a, b) =>
            Number(b.free) - Number(a.free) || a.load - b.load || a.label.localeCompare(b.label)
        );
        if (ranked.length === 0) {
          resolution.missing.push({
            field: 'agentRowId',
            written: account || '*',
            code: 'ACCOUNT_NOT_FOUND'
          });
          continue;
        }
        resolution.pools.set(written, ranked);
        resolution.ids.set(ref, ranked[0]!.id);
        resolution.names.set(ranked[0]!.id, ranked[0]!.label);
        continue;
      }
      const chosenAgents = which === 'all' ? pool : pool.filter(agent => agent.free);
      if (chosenAgents.length === 0) {
        resolution.missing.push({
          field: 'agentRowId',
          written: account || '*',
          code: pool.length === 0 ? 'ACCOUNT_NOT_FOUND' : 'NO_FREE_ACCOUNTS'
        });
      } else resolution.expansions.set(written, chosenAgents.slice(0, ASSISTANT_MAX_DRAFTS));
      continue;
    } else if (kind === 'account') {
      const picked = pickAgent(written, names.accounts);
      if (picked.kind === 'many') return { ok: false, ref, options: picked.candidates };
      if (picked.kind === 'one') id = picked.candidate.id;
    } else {
      let result = matchAssistantName(written, candidates);
      // An offer the plan creates by this very name is that name or nothing — never a near one.
      if (
        kind === 'offer' &&
        result.kind === 'one' &&
        plan.actions.some(a => a.type === 'create_offer' && a.offer === written) &&
        assistantKey(result.candidate.name) !== assistantKey(written)
      )
        result = { kind: 'none' };
      // «прокапс тр25»: the creatives' country picks ProCaps TR out of ProCaps TR and ProCaps BG.
      if (result.kind === 'many' && kind === 'offer') {
        const geo = creativeGeo(plan, written);
        const fit = geo
          ? result.candidates.filter(candidate =>
              candidate.name.trim().toUpperCase().endsWith(` ${geo}`)
            )
          : [];
        if (fit.length === 1) result = { kind: 'one', candidate: fit[0]! };
        // «21й відос» has no country: the offer whose country has a creative 21 is the one.
        else if (!geo) {
          const numbers = creativeNumbers(plan, written);
          const having: AssistantCandidate[] = [];
          for (const candidate of numbers.length ? result.candidates : []) {
            const country = /(?:^|\s)([A-Za-z]{2,3})$/u.exec(candidate.name.trim())?.[1];
            if (!country) continue;
            let all = true;
            for (const number of numbers) {
              const guess = `${country.toUpperCase()}_${number}`;
              if (matchAssistantName(guess, await searchMaterials(deps, guess)).kind !== 'one') {
                all = false;
                break;
              }
            }
            if (all) having.push(candidate);
          }
          if (having.length === 1) result = { kind: 'one', candidate: having[0]! };
        }
      }
      if (result.kind === 'many' && kind === 'offer' && !offerWanted(plan, written)) {
        resolution.offerSets.set(
          written,
          result.candidates.map(candidate => candidate.name)
        );
        continue;
      }
      if (result.kind === 'many' && chosen !== NEW_OFFER)
        return { ok: false, ref, options: result.candidates };
      if (result.kind === 'one' && chosen !== NEW_OFFER) id = result.candidate.id;
      else if (kind === 'offer' && chosen === NO_OFFER) continue;
      else if (kind === 'offer' && offerWanted(plan, written)) {
        // A new offer: created when the person asked for it, otherwise asked about once.
        // Asked for in the person's own words; a name only the model brought is asked about.
        const asked =
          personSaid(deps, written, true) &&
          plan.actions.some(a => a.type === 'create_offer' && a.offer === written);
        if (!asked && chosen !== NEW_OFFER)
          return {
            ok: false,
            ref,
            options: [
              { id: NEW_OFFER, name: `Створити офер «${written}»` },
              { id: NO_OFFER, name: 'Без офера' }
            ]
          };
        try {
          id = await createOffer(deps, written, resolution.createdOffers.length);
          names.offers.push({ id, name: written });
          resolution.createdOffers.push(written);
        } catch (error) {
          if (!(error instanceof EngineRefusal)) throw error;
          resolution.missing.push({
            field: 'offerId',
            written,
            code: error.code === 'PERMISSION_DENIED' ? 'OFFER_CREATE_FORBIDDEN' : error.code
          });
          continue;
        }
      }
    }
    if (!id) {
      resolution.missing.push({
        field: kind === 'offer' ? 'offerId' : kind === 'buyer' ? 'buyerId' : 'agentRowId',
        written,
        code:
          kind === 'offer'
            ? 'OFFER_NOT_FOUND'
            : kind === 'account'
              ? 'ACCOUNT_NOT_FOUND'
              : 'NOT_FOUND'
      });
      continue;
    }
    resolution.ids.set(ref, id);
    resolution.names.set(id, candidates.find(c => c.id === id)?.name ?? written);
  }
  return { ok: true, resolution };
}

function dateList(action: AssistantAction, deps: EngineDeps): Array<string | null> {
  const d = action.dates;
  if (!d) return [null];
  const today = launchDayInZone(deps.now, deps.timezone, 0);
  if (d.kind === 'today') return [today];
  if (d.kind === 'tomorrow') return [launchDayInZone(deps.now, deps.timezone, 1)];
  if (d.kind === 'date') return [d.date];
  const first = d.date ?? today;
  const start = new Date(`${first}T12:00:00Z`);
  return Array.from({ length: d.days ?? 1 }, (_, index) => {
    const day = new Date(start.getTime() + index * 86_400_000);
    return day.toISOString().slice(0, 10);
  });
}

async function profiles(
  deps: EngineDeps,
  offerId: string | null
): Promise<{
  offer: LaunchDefaultsProfile | null;
  workspace: LaunchDefaultsProfile | null;
}> {
  const read = async (name: string, args: Record<string, unknown>) => {
    const data = await call(deps.callerRpc, name, args);
    if (data === null) return null;
    if (
      !isRecord(data) ||
      !isRecord(data.config) ||
      !isRecord(data.subConfig) ||
      typeof data.version !== 'string'
    )
      throw new EngineRefusal('UNAVAILABLE');
    return data as unknown as LaunchDefaultsProfile;
  };
  const offer = offerId
    ? await read('get_launch_offer_defaults', { p_team: deps.teamId, p_offer: offerId })
    : null;
  const workspace = offer ? null : await read('get_launch_defaults', { p_team: deps.teamId });
  return { offer, workspace };
}

function refsFor(
  resolution: Resolution,
  change: AssistantFieldChange,
  deps: EngineDeps,
  offerId?: string
) {
  const id = (kind: RefKind, value: unknown) =>
    typeof value === 'string' ? resolution.ids.get(`${kind}:${value}`) : undefined;
  const list = Array.isArray(change.value) ? change.value : [change.value];
  const materials = list.flatMap(item => {
    const material = typeof item === 'string' ? resolution.materials.get(item) : undefined;
    return material ? [material] : [];
  });
  return {
    offerId: change.field === 'offerId' ? id('offer', change.value) : offerId,
    buyerId: id('buyer', change.value),
    agentRowId: id('account', change.value),
    materials,
    url: assistantUrlSlot(change.value, deps.urls) ?? undefined
  };
}

/** Applies changes to a draft; failures are reported per field, never replaced by defaults. */
function applyChanges(
  draft: Draft,
  changes: AssistantFieldChange[],
  resolution: Resolution,
  deps: EngineDeps,
  problems: Array<{ field: string; written: string; code: string }>
): Draft {
  let next = draft;
  for (const change of changes) {
    if (change.field === 'creatives') {
      const list = Array.isArray(change.value) ? change.value : [change.value];
      if (list.every(item => typeof item === 'string' && !resolution.materials.has(item))) continue;
    }
    const result = applyAssistantChange(next as never, change, {
      now: deps.now,
      timezone: deps.timezone,
      refs: refsFor(resolution, change, deps)
    });
    if (result.ok) next = result.draft as Draft;
    else if (result.code !== 'UNRESOLVED')
      problems.push({
        field: change.field,
        written: String(change.value ?? ''),
        code: result.code
      });
  }
  return next;
}

function requestKey(deps: EngineDeps, step: number, row: string): string {
  return `asst-${deps.commandId.replace(/-/gu, '')}-${step}-${row}`.slice(0, 200);
}

async function recordEffect(
  deps: EngineDeps,
  input: {
    step: number;
    row: string;
    kind: 'draft_created' | 'draft_updated' | 'defaults_saved';
    launchId?: string | null;
    offerId?: string | null;
    before?: string | null;
    after?: string | null;
    fields?: Array<{ path: string; before: unknown; after: unknown }>;
  }
): Promise<void> {
  await call(deps.serviceRpc, 'service_assistant_effect', {
    p_command: deps.commandId,
    p_step: input.step,
    p_row_key: input.row,
    p_kind: input.kind,
    p_launch: input.launchId ?? null,
    p_offer: input.offerId ?? null,
    p_version_before: input.before ?? null,
    p_version_after: input.after ?? null,
    p_fields: input.fields ?? []
  });
}

function budgetText(config: Draft): string | null {
  const mode = config.budgetMode;
  if (mode === 'single' && typeof config.maxBudget === 'number') return `${config.maxBudget}`;
  if (mode === 'manual' && Array.isArray(config.budgets))
    return (config.budgets as number[]).join(' / ');
  if (typeof config.maxBudget === 'number')
    return typeof config.minBudget === 'number'
      ? `${config.minBudget}–${config.maxBudget}`
      : `≤${config.maxBudget}`;
  return null;
}

/** Card rows from stored launches, in the order given. */
export async function cardRows(
  deps: Pick<EngineDeps, 'serviceRpc' | 'userId' | 'teamId'>,
  ids: string[] | null,
  date: string | null,
  /** A removal by day sees launched launches too; a review or a launch never offers them. */
  withLaunched = false
): Promise<{ rows: AssistantRow[]; truncated: boolean }> {
  // The database reads at most 101 ids at a time; a command that touched more (or its undo) is
  // read in parts rather than failing after its writes.
  if (ids && ids.length > ASSISTANT_MAX_DRAFTS) {
    const parts: AssistantRow[] = [];
    for (let start = 0; start < ids.length; start += ASSISTANT_MAX_DRAFTS) {
      const part = await cardRows(
        deps,
        ids.slice(start, start + ASSISTANT_MAX_DRAFTS),
        date,
        withLaunched
      );
      parts.push(...part.rows);
    }
    return {
      rows: parts
        .slice(0, ASSISTANT_MAX_DRAFTS * 4)
        .map((row, index) => ({ ...row, n: index + 1 })),
      truncated: parts.length > ASSISTANT_MAX_DRAFTS * 4
    };
  }
  const data = withLaunched
    ? await call(deps.serviceRpc, 'service_assistant_rows_v2', {
        p_user: deps.userId,
        p_team: deps.teamId,
        p_ids: ids,
        p_date: date,
        p_with_launched: true
      })
    : await call(deps.serviceRpc, 'service_assistant_rows', {
        p_user: deps.userId,
        p_team: deps.teamId,
        p_ids: ids,
        p_date: date
      });
  const list = Array.isArray(data) ? data : [];
  const truncated = list.length > ASSISTANT_MAX_DRAFTS;
  const rows = list.slice(0, ASSISTANT_MAX_DRAFTS).flatMap((item, index): AssistantRow[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.version !== 'string')
      return [];
    const config = isRecord(item.config) ? item.config : {};
    const names = new Map<string, string>();
    if (Array.isArray(item.materials))
      for (const m of item.materials)
        if (isRecord(m) && typeof m.id === 'string' && typeof m.name === 'string')
          names.set(m.id, m.name);
    const creatives = Array.isArray(config.creatives)
      ? (config.creatives as unknown[]).flatMap(c =>
          isRecord(c) && typeof c.materialId === 'string'
            ? [names.get(c.materialId) ?? String(c.alias ?? '')]
            : []
        )
      : typeof config.materialId === 'string'
        ? [names.get(config.materialId) ?? String(config.creativeAlias ?? '')]
        : [];
    const catalog = isRecord(config.catalog) ? config.catalog : null;
    const generation = typeof item.generationState === 'string' ? item.generationState : null;
    return [
      {
        n: index + 1,
        launchId: item.id,
        version: item.version,
        account: typeof item.account === 'string' ? item.account : null,
        offer: typeof item.offer === 'string' ? item.offer : null,
        creatives,
        launchDate: typeof config.launchDate === 'string' ? config.launchDate : null,
        campaignCount: typeof config.campaignCount === 'number' ? config.campaignCount : null,
        productCount:
          catalog && typeof catalog.productCount === 'number' ? catalog.productCount : null,
        budget: budgetText(config),
        url: typeof config.originalUrl === 'string' && config.originalUrl.length > 0,
        r2: catalog ? catalog.copyVideoToR2 === true : null,
        blocked: [
          ...(generation && !['failed', 'canceled'].includes(generation)
            ? [{ field: 'generation', code: 'LAUNCHED' }]
            : []),
          // Still being generated: nothing may touch it until it ends, as in Launches.
          ...(generation && !['failed', 'canceled', 'succeeded'].includes(generation)
            ? [{ field: 'generation', code: 'GENERATING' }]
            : []),
          ...assistantBlockedFields(config as never)
        ]
      }
    ];
  });
  return { rows, truncated };
}

async function createDrafts(
  action: AssistantAction,
  step: number,
  deps: EngineDeps,
  resolution: Resolution,
  problems: Array<{ field: string; written: string; code: string }>,
  differences: Array<{ field: string; from: string | null; to: string }>,
  created: string[]
): Promise<void> {
  const offerId = action.offer ? (resolution.ids.get(`offer:${action.offer}`) ?? null) : null;
  const accounts = action.accounts.length
    ? action.accounts.flatMap(written => {
        const expanded = resolution.expansions.get(written);
        if (expanded)
          return expanded.map(agent => ({ written: agent.label, id: agent.id as string | null }));
        return [{ written, id: resolution.ids.get(`account:${written}`) ?? null }];
      })
    : [{ written: null as string | null, id: null as string | null }];
  if (accounts.length === 0) return;
  const notes = await actionNotes(action, deps, resolution, problems);
  const dates = dateList(action, deps);
  const count = action.count ?? 1;
  const total = accounts.length * dates.length * count;
  // The bound holds for the whole message, not each step: sixteen steps of sixty were 960 drafts.
  if (total + created.length > ASSISTANT_MAX_DRAFTS) throw new EngineRefusal('PLAN_TOO_LARGE');
  let base: Draft;
  if (action.base === 'copy_of_row' && action.baseRow) {
    const row = deps.shown[action.baseRow - 1];
    if (!row) throw new EngineRefusal('NO_CONTEXT_CARD');
    const detail = await call(deps.callerRpc, 'get_launch', {
      p_team: deps.teamId,
      p_launch: row.launchId,
      p_revision: null
    });
    base = isRecord(detail) && isRecord(detail.draft) ? structuredClone(detail.draft) : {};
  } else {
    const profile = await profiles(deps, offerId);
    base = newDraftFromDefaults({ ...profile, now: deps.now, timezone: deps.timezone })
      .draft as Draft;
    const profileConfig = (profile.offer ?? profile.workspace)?.config ?? {};
    for (const change of action.fields) {
      const field = launchField(change.field);
      if (!field || !field.profile || !isLaunchDefaultPath(change.field)) continue;
      const before = readLaunchPath(profileConfig as never, change.field as LaunchDefaultPath);
      if (
        before !== undefined &&
        JSON.stringify(before) !== JSON.stringify(change.value) &&
        change.op === 'set' &&
        !String(change.value).startsWith('⟦url')
      )
        differences.push({
          field: change.field,
          from: JSON.stringify(before),
          to: JSON.stringify(change.value)
        });
    }
  }
  if (offerId) base.offerId = offerId;
  let campaigns = 0;
  let row = 0;
  for (const account of accounts) {
    for (const day of dates) {
      for (let copy = 0; copy < count; copy++) {
        let draft: Draft = structuredClone(base);
        if (account.id) draft.agentRowId = account.id;
        if (day) {
          draft.launchDate = day;
          draft.timezone = draft.timezone ?? deps.timezone;
        }
        draft = applyChanges(draft, action.fields, resolution, deps, problems);
        if (notes) draft.notes = freshNotes(notes);
        for (const override of action.overrides) {
          if (account.written && sameAccount(override.account, account.written))
            draft = applyChanges(draft, override.fields, resolution, deps, problems);
        }
        campaigns += typeof draft.campaignCount === 'number' ? draft.campaignCount : 0;
        if (campaigns > ASSISTANT_MAX_CAMPAIGNS) throw new EngineRefusal('PLAN_TOO_LARGE');
        const key = requestKey(deps, step, `r${row}`);
        const saved = await call(deps.callerRpc, 'save_launch_draft', {
          p_team: deps.teamId,
          p_launch: null,
          p_expected_version: null,
          p_request_key: key,
          p_config: { schemaVersion: 1, ...draft },
          p_expected_sources: null
        });
        if (!isRecord(saved) || typeof saved.id !== 'string')
          throw new EngineRefusal('UNAVAILABLE');
        await recordEffect(deps, {
          step,
          row: `r${row}`,
          kind: 'draft_created',
          launchId: saved.id,
          after: typeof saved.version === 'string' ? saved.version : null
        });
        created.push(saved.id);
        row++;
      }
    }
  }
}

async function updateRows(
  action: AssistantAction,
  step: number,
  deps: EngineDeps,
  resolution: Resolution,
  problems: Array<{ field: string; written: string; code: string }>,
  touched: string[]
): Promise<void> {
  if (deps.shown.length === 0) throw new EngineRefusal('NO_CONTEXT_CARD');
  let targets = action.rows.length
    ? (action.rows.map(n => deps.shown[n - 1]).filter(Boolean) as AssistantRow[])
    : deps.shown;
  if (action.accounts.length)
    targets = targets.filter(row =>
      action.accounts.some(
        a => row.account && sameAccount(a.split('*')[0] || row.account, row.account)
      )
    );
  for (const [index, target] of targets.entries()) {
    // «на вільних» over several drafts: each takes the next ad account of the pool.
    const changes = action.fields.map(change => {
      const pool =
        change.field === 'agentRowId' && typeof change.value === 'string'
          ? resolution.pools.get(change.value)
          : undefined;
      if (!pool?.length) return change;
      const agent = pool[index % pool.length]!;
      resolution.ids.set(`account:${agent.label}`, agent.id);
      return { ...change, value: agent.label };
    });
    const detail = await call(deps.callerRpc, 'get_launch', {
      p_team: deps.teamId,
      p_launch: target.launchId,
      p_revision: null
    });
    if (!isRecord(detail) || !isRecord(detail.draft) || typeof detail.version !== 'string')
      throw new EngineRefusal('UNAVAILABLE');
    if (detail.version !== target.version) {
      problems.push({ field: 'row', written: String(target.n), code: 'EDIT_CONFLICT' });
      continue;
    }
    const before = detail.draft as Draft;
    let next = applyChanges(before, changes, resolution, deps, problems);
    const notes = await actionNotes(action, deps, resolution, problems);
    if (notes) next = { ...next, notes: freshNotes(notes) };
    for (const override of action.overrides) {
      if (target.account && sameAccount(override.account, target.account))
        next = applyChanges(next, override.fields, resolution, deps, problems);
    }
    if (JSON.stringify(next) === JSON.stringify(before)) continue;
    const fields = Object.keys({ ...before, ...next })
      .filter(key => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
      .map(path => ({ path, before: before[path] ?? null, after: next[path] ?? null }));
    const saved = await call(deps.callerRpc, 'save_launch_draft', {
      p_team: deps.teamId,
      p_launch: target.launchId,
      p_expected_version: target.version,
      p_request_key: requestKey(deps, step, `u${target.n}`),
      p_config: next,
      p_expected_sources: isRecord(detail.expectedSourceSnapshot)
        ? detail.expectedSourceSnapshot
        : null
    });
    if (!isRecord(saved) || typeof saved.version !== 'string')
      throw new EngineRefusal('UNAVAILABLE');
    await recordEffect(deps, {
      step,
      row: `u${target.n}`,
      kind: 'draft_updated',
      launchId: target.launchId,
      before: target.version,
      after: saved.version,
      fields
    });
    touched.push(target.launchId);
  }
}

async function proposeDefaults(
  action: AssistantAction,
  deps: EngineDeps,
  resolution: Resolution,
  canSave: boolean
): Promise<Card> {
  const offerId = action.offer ? resolution.ids.get(`offer:${action.offer}`) : undefined;
  if (!offerId) throw new EngineRefusal('OFFER_NOT_FOUND');
  if (!canSave) throw new EngineRefusal('DEFAULTS_FORBIDDEN');
  const profile = await call(deps.callerRpc, 'get_launch_offer_defaults', {
    p_team: deps.teamId,
    p_offer: offerId
  });
  const stored = isRecord(profile) && isRecord(profile.config) ? (profile.config as Draft) : {};
  const sub = isRecord(profile) && isRecord(profile.subConfig) ? (profile.subConfig as Draft) : {};
  const mask: string[] = [];
  const before: Record<string, unknown> = {};
  const values: Record<string, unknown> = {};
  const changes: Array<{ field: string; from: string | null; to: string }> = [];
  for (const change of action.fields) {
    if (!isLaunchDefaultPath(change.field) || change.op !== 'set') continue;
    let path: string = change.field;
    let value: unknown = change.value;
    // A buyer by name and a pasted link are resolved exactly as on a draft: the profile stores the
    // buyer's id and the link itself, never «goor» or ⟦url:1⟧.
    if (!path.startsWith('catalog.') && !path.startsWith('subConfig.')) {
      const problems: Array<{ field: string; written: string; code: string }> = [];
      const applied = applyChanges(structuredClone(stored), [change], resolution, deps, problems);
      const resolved = readLaunchPath(applied as never, path as LaunchDefaultPath);
      if (problems.length || resolved === undefined || resolved === change.value) {
        if (change.field === 'buyerId' || change.field === 'originalUrl') continue;
      }
      if (resolved !== undefined) value = resolved;
    }
    // A profile without a catalog stores the whole object: the profile writer requires its core.
    if (path.startsWith('catalog.') && !isRecord(stored.catalog)) {
      const key = path.slice('catalog.'.length);
      const fresh = newDraftFromDefaults({
        offer: null,
        workspace: null,
        now: deps.now,
        timezone: deps.timezone
      }).draft as Draft;
      path = 'catalog';
      value = {
        ...(isRecord(values.catalog) ? values.catalog : (fresh.catalog as Draft)),
        [key]: change.value
      };
    }
    const current = path.startsWith('subConfig.')
      ? sub[path.slice('subConfig.'.length)]
      : readLaunchPath(stored as never, path as LaunchDefaultPath);
    if (!mask.includes(path)) mask.push(path);
    if (current !== undefined) before[path] = current;
    values[path] = value;
    const shown = (raw: unknown) =>
      change.field === 'buyerId' && typeof raw === 'string'
        ? (resolution.names.get(raw) ?? raw)
        : raw;
    changes.push({
      field: change.field,
      from: current === undefined ? null : JSON.stringify(shown(current)),
      to: JSON.stringify(shown(path === change.field ? value : change.value))
    });
  }
  // Notes taken from another offer («тайтл як у Туреччині») become this offer's default notes.
  const notes = await actionNotes(action, deps, resolution, []);
  if (notes) {
    const label = (note: { title: string; text: string }) =>
      (note.title.trim() || note.text.trim().replace(/\s+/gu, ' ')).slice(0, 60);
    const current = Array.isArray(stored.notes)
      ? (stored.notes as Array<{ title: string; text: string }>)
      : [];
    if (!mask.includes('notes')) mask.push('notes');
    if (stored.notes !== undefined) before.notes = stored.notes;
    values.notes = freshNotes(notes);
    changes.push({
      field: 'notes',
      from: current.length ? JSON.stringify(current.map(label)) : null,
      to: JSON.stringify(notes.map(label))
    });
  }
  if (!mask.length) throw new EngineRefusal('FIELD_NOT_SUPPORTED');
  return {
    kind: 'profile',
    payload: {
      offerId,
      offer: resolution.names.get(offerId) ?? action.offer ?? '',
      changes,
      mask,
      before,
      values
    }
  };
}

/**
 * Runs a resolved plan. A profile proposal stops the plan: the actions after it wait for the
 * person's «Зберегти» and run then, without a model.
 */
/**
 * The drafts an action points at: rows of the shown card when it names them, otherwise the
 * space's drafts of the named days (today and tomorrow when none) narrowed by offer and account.
 */
async function selectRows(
  action: AssistantAction,
  deps: EngineDeps,
  resolution: Resolution,
  created: string[],
  withLaunched = false
): Promise<{ rows: AssistantRow[]; truncated: boolean; date: string | null }> {
  if (action.rows.length > 0) {
    const ids = action.rows.flatMap(n => (deps.shown[n - 1] ? [deps.shown[n - 1]!.launchId] : []));
    if (ids.length === 0) throw new EngineRefusal('NO_CONTEXT_CARD');
    return { ...(await cardRows(deps, ids, null)), date: null };
  }
  const accounts = action.accounts.map(a => a.split('*')[0]!).filter(Boolean);
  // «той, що з тр25»: creatives named in a selection narrow it to drafts that carry them.
  const creativeKeys = new Set(
    action.fields
      .filter(change => change.field === 'creatives')
      .flatMap(change => (Array.isArray(change.value) ? change.value : [change.value]))
      .flatMap(written => {
        const found = typeof written === 'string' ? resolution.materials.get(written) : undefined;
        return found ? [assistantKey(found.name.replace(/\.[A-Za-z0-9]{1,5}$/u, ''))] : [];
      })
  );
  const filtered =
    Boolean(action.offer) || accounts.length > 0 || action.dates !== null || creativeKeys.size > 0;
  if (!filtered) {
    const ids = created.length ? created : deps.shown.map(row => row.launchId);
    if (ids.length) return { ...(await cardRows(deps, ids, null)), date: null };
  }
  const days = action.dates
    ? dateList(action, deps).filter((day): day is string => Boolean(day))
    : [launchDayInZone(deps.now, deps.timezone, 0), launchDayInZone(deps.now, deps.timezone, 1)];
  let rows: AssistantRow[] = [];
  let truncated = false;
  for (const day of days.slice(0, 7)) {
    const part = await cardRows(deps, null, day, withLaunched);
    rows.push(...part.rows);
    truncated ||= part.truncated;
  }
  if (action.offer) {
    const id = resolution.ids.get(`offer:${action.offer}`);
    const name = id ? resolution.names.get(id) : null;
    const names = name ? [name] : (resolution.offerSets.get(action.offer) ?? []);
    rows = rows.filter(row => row.offer !== null && names.includes(row.offer));
  }
  if (accounts.length)
    rows = rows.filter(
      row => row.account !== null && accounts.some(written => sameAccount(written, row.account!))
    );
  if (creativeKeys.size)
    rows = rows.filter(row =>
      row.creatives.some(name =>
        creativeKeys.has(assistantKey(name.replace(/\.[A-Za-z0-9]{1,5}$/u, '')))
      )
    );
  rows = rows.slice(0, ASSISTANT_MAX_DRAFTS).map((row, index) => ({ ...row, n: index + 1 }));
  return { rows, truncated, date: days.length === 1 ? days[0]! : null };
}

export async function executePlan(
  plan: AssistantPlan,
  deps: EngineDeps,
  resolution: Resolution,
  options: { canSaveDefaults: boolean }
): Promise<EngineOutcome> {
  const problems = [...resolution.missing];
  const differences: Array<{ field: string; from: string | null; to: string }> = [];
  const created: string[] = [];
  const touched: string[] = [];
  const cards: Card[] = [];
  let deferred: AssistantAction[] = [];
  const asked = plan.actions.find(action => action.type === 'ask' && action.question);
  if (asked && asked.question) {
    return {
      kind: 'done',
      status: 'done',
      deferred: [],
      cards: [
        {
          kind: 'question',
          payload: {
            about: asked.question.about,
            source: 'model',
            options: asked.question.options.map((label, index) => ({ id: `o${index + 1}`, label }))
          }
        }
      ]
    };
  }
  const renamed = new Map<string, string>();
  try {
    for (let step = 0; step < plan.actions.length; step++) {
      const action = plan.actions[step]!;
      if (action.type === 'create_drafts')
        await createDrafts(action, step, deps, resolution, problems, differences, created);
      else if (action.type === 'update_fields')
        await updateRows(action, step, deps, resolution, problems, touched);
      else if (action.type === 'save_offer_defaults') {
        // «…і збережи офер по дефолту» without values of its own saves what the same message
        // set on that offer's drafts; the model often names them only once.
        const drafted = plan.actions.find(
          other => other.type === 'create_drafts' && other.offer === action.offer
        );
        const own = action.fields.filter(change => isLaunchDefaultPath(change.field));
        const effective =
          drafted && own.length === 0
            ? {
                ...action,
                fields: drafted.fields.filter(change => isLaunchDefaultPath(change.field)),
                notesFrom: action.notesFrom ?? drafted.notesFrom ?? null,
                notesLanguage: action.notesLanguage ?? drafted.notesLanguage ?? null
              }
            : action;
        cards.push(await proposeDefaults(effective, deps, resolution, options.canSaveDefaults));
        deferred = plan.actions.slice(step + 1);
        break;
      } else if (action.type === 'show_review' || action.type === 'show_status') {
        const picked = await selectRows(action, deps, resolution, created);
        cards.push({
          kind: 'review',
          payload: {
            date: picked.date,
            timezone: deps.timezone,
            rows: picked.rows,
            ready: picked.rows.filter(row => row.blocked.length === 0).length,
            truncated: picked.truncated
          }
        });
      } else if (action.type === 'release_accounts') {
        cards.push(await releaseCard(action, deps));
      } else if (action.type === 'use_tool' && action.tool) {
        // Everything else in the space: a read answers with a table, a write prepares a card.
        const card = await runTool(action.tool, action.args, {
          teamId: deps.teamId,
          userId: deps.userId,
          callerRpc: deps.callerRpc,
          timezone: deps.timezone,
          now: deps.now,
          renamed
        });
        rememberRenames(card, renamed);
        cards.push(card);
      } else if (action.type === 'archive_drafts') {
        // Only a card: they go away when the person presses «Видалити N» on it. Launched ones too,
        // as the Launches tab deletes them (their catalog stays in the space) — owner, 2026-11-22:
        // «видали всі запуски на завтра» that kept two launched ones read as a failure. Only a
        // launch still being generated is left, and the card says why.
        const picked = await selectRows(action, deps, resolution, created, true);
        const generating = picked.rows.filter(row =>
          row.blocked.some(entry => entry.code === 'GENERATING')
        ).length;
        // «чернетки» keeps launched ones out and says so; «запуски» takes them too.
        const withLaunched = action.includeLaunched === true;
        const launchedOut = withLaunched
          ? 0
          : picked.rows.filter(
              row =>
                row.blocked.some(entry => entry.code === 'LAUNCHED') &&
                !row.blocked.some(entry => entry.code === 'GENERATING')
            ).length;
        const rows = picked.rows
          .filter(row => !row.blocked.some(entry => entry.code === 'GENERATING'))
          .filter(row => withLaunched || !row.blocked.some(entry => entry.code === 'LAUNCHED'))
          .map((row, index) => ({ ...row, n: index + 1 }));
        cards.push({
          kind: 'review',
          payload: {
            purpose: 'archive',
            date: picked.date,
            timezone: deps.timezone,
            rows,
            ready: rows.length,
            launchedKept: launchedOut,
            generatingKept: generating,
            launchedIncluded: rows.filter(row =>
              row.blocked.some(entry => entry.code === 'LAUNCHED')
            ).length,
            truncated: picked.truncated
          }
        });
      } else if (action.type === 'ask' && action.question) {
        cards.push({
          kind: 'question',
          payload: {
            about: action.question.about,
            source: 'model',
            options: action.question.options.map((label, index) => ({ id: `o${index + 1}`, label }))
          }
        });
      }
    }
  } catch (error) {
    if (error instanceof EngineRefusal && created.length === 0 && touched.length === 0) {
      return { kind: 'rejected', code: error.code };
    }
    if (!(error instanceof EngineRefusal)) throw error;
    problems.push({ field: 'plan', written: '', code: error.code });
  }
  const ids = [...created, ...touched];
  if (ids.length > 0) {
    const { rows } = await cardRows(deps, ids, null);
    cards.unshift({
      kind: 'result',
      payload: {
        rows,
        differences,
        unresolved: problems,
        profile: null,
        campaigns: rows.reduce((sum, row) => sum + (row.campaignCount ?? 0), 0),
        date: rows[0]?.launchDate ?? null,
        createdOffers: resolution.createdOffers
      }
    });
  }
  if (resolution.createdAccounts.length > 0) {
    cards.unshift({ kind: 'status', payload: { accountsCreated: resolution.createdAccounts } });
  }
  if (ids.length > 0) {
    /* the result card above already lists the drafts */
  } else if (resolution.createdOffers.length > 0) {
    cards.unshift({ kind: 'status', payload: { offersCreated: resolution.createdOffers } });
    if (problems.length > 0)
      cards.push({
        kind: 'result',
        payload: {
          rows: [],
          differences,
          unresolved: problems,
          profile: null,
          campaigns: 0,
          date: null
        }
      });
  } else if (problems.length > 0) {
    cards.unshift({
      kind: 'result',
      payload: {
        rows: [],
        differences,
        unresolved: problems,
        profile: null,
        campaigns: 0,
        date: null
      }
    });
  }
  return { kind: 'done', cards, status: problems.length ? 'partial' : 'done', deferred };
}

/** The review card: the rows «Запустити N» would send, built from stored rows only. */
export async function reviewCard(
  deps: Pick<EngineDeps, 'serviceRpc' | 'userId' | 'teamId' | 'now' | 'timezone' | 'shown'>,
  selector: 'today' | 'shown' | string[]
): Promise<Card> {
  const date = selector === 'today' ? launchDayInZone(deps.now, deps.timezone, 0) : null;
  const ids =
    selector === 'today'
      ? null
      : selector === 'shown'
        ? deps.shown.map(row => row.launchId)
        : selector;
  if (ids !== null && ids.length === 0) {
    return {
      kind: 'review',
      payload: { date, timezone: deps.timezone, rows: [], ready: 0, truncated: false }
    };
  }
  const { rows, truncated } = await cardRows(deps, ids, date);
  return {
    kind: 'review',
    payload: {
      date,
      timezone: deps.timezone,
      rows,
      ready: rows.filter(row => row.blocked.length === 0).length,
      truncated
    }
  };
}

export { EngineRefusal };
