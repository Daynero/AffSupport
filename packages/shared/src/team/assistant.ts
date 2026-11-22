/**
 * 064: the launch assistant's contract — what the model may answer, what the server shows, and
 * the short replies Soty understands without a model.
 *
 * The model only interprets. It returns references as the person wrote them ("TR 16", "G2",
 * "прокапс"); Soty resolves them against the space with the person's own rights, checks every
 * field against the launch field registry, saves ordinary drafts, and builds every card itself.
 * There is no action that starts generation: only the «Запустити N» button on a review card does.
 */
import { assistantFieldPaths } from './launches/fields.js';

export const ASSISTANT_ACTIONS = [
  'create_drafts',
  'update_fields',
  'create_offer',
  'create_account',
  'release_accounts',
  'use_tool',
  'archive_drafts',
  'save_offer_defaults',
  'show_review',
  'show_status',
  'ask',
  'out_of_scope'
] as const;
export type AssistantActionType = (typeof ASSISTANT_ACTIONS)[number];

export const ASSISTANT_FIELD_OPS = ['set', 'clear', 'add', 'remove', 'reorder'] as const;
export type AssistantFieldOp = (typeof ASSISTANT_FIELD_OPS)[number];

export type AssistantValue = string | number | boolean | null | Array<string | number>;

export interface AssistantFieldChange {
  field: string;
  op: AssistantFieldOp;
  value: AssistantValue;
}

export interface AssistantDates {
  kind: 'today' | 'tomorrow' | 'date' | 'each_day';
  /** YYYY-MM-DD for `date`, the first day for `each_day`; otherwise null. */
  date: string | null;
  /** Number of consecutive days for `each_day`; otherwise null. */
  days: number | null;
}

export interface AssistantAction {
  type: AssistantActionType;
  /** Offer as written, or null when not named. */
  offer: string | null;
  /** Ad account labels as written ("G1"); create: one launch per account. */
  accounts: string[];
  /** Launches per account (and per day); create only. */
  count: number | null;
  dates: AssistantDates | null;
  /** Where a new launch's values come from. */
  base: 'offer_defaults' | 'copy_of_row' | null;
  /** 1-based row of the card the person is looking at, for copy_of_row. */
  baseRow: number | null;
  /** 1-based rows of that card an update targets; empty means every row shown. */
  rows: number[];
  fields: AssistantFieldChange[];
  /** Exceptions for one account among the created or targeted launches. */
  overrides: Array<{ account: string; fields: AssistantFieldChange[] }>;
  question: { about: string; options: string[] } | null;
  /**
   * Notes taken from another offer's defaults («тайтл як у Туреччині»), as written; Soty reads
   * them. Absent in plans stored before this field existed.
   */
  notesFrom: string | null;
  /** The language to translate those notes into («Spanish (Mexico)»); null keeps them as they are. */
  notesLanguage: string | null;
  /**
   * archive_drafts: true when the person said «запуски» («видали всі запуски на завтра») — launched
   * ones go too, as the Launches tab deletes them; false or null for «чернетки».
   */
  includeLaunched: boolean | null;
  /** use_tool: the space tool to use (search, folders, tags, finance, tasks…); null otherwise. */
  tool: string | null;
  /** use_tool: its arguments as written, checked by the tool itself. */
  args: AssistantToolArg[];
}

export interface AssistantToolArg {
  name: string;
  value: string | number | boolean | null | Array<string | number>;
}

/** Bounds of a tool call in a plan. */
export const ASSISTANT_TOOL_ARGS_MAX = 20;

export interface AssistantPlan {
  /** One short sentence for the person (escaped plain text, ≤ 300 characters). */
  reply: string;
  actions: AssistantAction[];
}

/** Bounds of one plan, checked before anything is written. */
export const ASSISTANT_MAX_ACTIONS = 16;
export const ASSISTANT_MAX_FIELDS = 30;
export const ASSISTANT_MAX_DRAFTS = 100;
export const ASSISTANT_MAX_CAMPAIGNS = 1_000;
export const ASSISTANT_MAX_DAYS = 31;
export const ASSISTANT_REPLY_MAX = 300;

/** The JSON Schema the model's answer must match (structured output), built from the registry. */
export function assistantPlanSchema(): Record<string, unknown> {
  const value = {
    anyOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
      { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } }
    ]
  };
  const change = {
    type: 'object',
    properties: {
      field: { type: 'string', enum: assistantFieldPaths() },
      op: { type: 'string', enum: [...ASSISTANT_FIELD_OPS] },
      value
    },
    required: ['field', 'op', 'value'],
    additionalProperties: false
  };
  const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const nullableInteger = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
  return {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...ASSISTANT_ACTIONS] },
            offer: nullableString,
            accounts: { type: 'array', items: { type: 'string' } },
            count: nullableInteger,
            dates: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['today', 'tomorrow', 'date', 'each_day'] },
                    date: nullableString,
                    days: nullableInteger
                  },
                  required: ['kind', 'date', 'days'],
                  additionalProperties: false
                },
                { type: 'null' }
              ]
            },
            base: {
              anyOf: [{ type: 'string', enum: ['offer_defaults', 'copy_of_row'] }, { type: 'null' }]
            },
            baseRow: nullableInteger,
            rows: { type: 'array', items: { type: 'integer' } },
            fields: { type: 'array', items: change },
            overrides: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  account: { type: 'string' },
                  fields: { type: 'array', items: change }
                },
                required: ['account', 'fields'],
                additionalProperties: false
              }
            },
            question: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    about: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['about', 'options'],
                  additionalProperties: false
                },
                { type: 'null' }
              ]
            },
            notesFrom: nullableString,
            notesLanguage: nullableString,
            includeLaunched: { type: ['boolean', 'null'] },
            tool: nullableString,
            args: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, value },
                required: ['name', 'value'],
                additionalProperties: false
              }
            }
          },
          required: [
            'type',
            'offer',
            'accounts',
            'count',
            'dates',
            'base',
            'baseRow',
            'rows',
            'fields',
            'overrides',
            'question',
            'notesFrom',
            'notesLanguage',
            'includeLaunched',
            'tool',
            'args'
          ],
          additionalProperties: false
        }
      }
    },
    required: ['reply', 'actions'],
    additionalProperties: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every(key => keys.includes(key));
}

function stringList(value: unknown, max: number, length = 200): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(item => typeof item === 'string' && item.length > 0 && item.length <= length)
  );
}

function parseChange(value: unknown): AssistantFieldChange | null {
  if (!isRecord(value) || !exactKeys(value, ['field', 'op', 'value'])) return null;
  const { field, op, value: raw } = value;
  if (typeof field !== 'string' || !(ASSISTANT_FIELD_OPS as readonly unknown[]).includes(op))
    return null;
  const scalar = (item: unknown) =>
    item === null || ['string', 'number', 'boolean'].includes(typeof item);
  if (Array.isArray(raw)) {
    if (
      raw.length > 100 ||
      !raw.every(item => typeof item === 'string' || typeof item === 'number')
    )
      return null;
  } else if (!scalar(raw)) return null;
  if (typeof raw === 'string' && raw.length > 8_192) return null;
  return { field, op: op as AssistantFieldOp, value: raw as AssistantValue };
}

const NOTES_KEYS = ['notesFrom', 'notesLanguage', 'includeLaunched', 'tool', 'args'];

const ACTION_KEYS = [
  'type',
  'offer',
  'accounts',
  'count',
  'dates',
  'base',
  'baseRow',
  'rows',
  'fields',
  'overrides',
  'question'
] as const;

/**
 * The model's answer, checked as untrusted data: exact keys, closed values, bounded sizes. Any
 * deviation rejects the whole plan before anything is written.
 */
export function parseAssistantPlan(value: unknown): AssistantPlan | null {
  if (!isRecord(value) || !exactKeys(value, ['reply', 'actions'])) return null;
  const { reply, actions } = value;
  // The reply is cut to its length below; only its type matters here.
  if (typeof reply !== 'string') return null;
  if (!Array.isArray(actions) || actions.length > ASSISTANT_MAX_ACTIONS) return null;
  const parsed: AssistantAction[] = [];
  for (const item of actions) {
    // Every key of the contract, and the two notes keys when present (older stored plans lack them).
    if (
      !isRecord(item) ||
      Object.keys(item).some(
        key => !(ACTION_KEYS as readonly string[]).includes(key) && !NOTES_KEYS.includes(key)
      ) ||
      ACTION_KEYS.some(key => !(key in item))
    )
      return null;
    const notesFrom = item.notesFrom ?? null;
    const notesLanguage = item.notesLanguage ?? null;
    if (notesFrom !== null && (typeof notesFrom !== 'string' || notesFrom.length > 200))
      return null;
    if (notesLanguage !== null && (typeof notesLanguage !== 'string' || notesLanguage.length > 60))
      return null;
    const includeLaunched = item.includeLaunched ?? null;
    if (includeLaunched !== null && typeof includeLaunched !== 'boolean') return null;
    const tool = item.tool ?? null;
    if (tool !== null && (typeof tool !== 'string' || !/^[a-z_]{2,40}$/u.test(tool))) return null;
    const rawArgs = item.args ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.length > ASSISTANT_TOOL_ARGS_MAX) return null;
    const args: AssistantToolArg[] = [];
    for (const arg of rawArgs) {
      if (!isRecord(arg) || !exactKeys(arg, ['name', 'value']) || typeof arg.name !== 'string')
        return null;
      const change = parseChange({ field: arg.name, op: 'set', value: arg.value });
      if (!change || arg.name.length > 40) return null;
      args.push({ name: arg.name, value: change.value });
    }
    if (item.type === 'use_tool' && tool === null) continue;
    if (!(ASSISTANT_ACTIONS as readonly unknown[]).includes(item.type)) return null;
    if (item.offer !== null && (typeof item.offer !== 'string' || item.offer.length > 200))
      return null;
    if (!stringList(item.accounts, ASSISTANT_MAX_DRAFTS, 60)) return null;
    if (
      item.count !== null &&
      (typeof item.count !== 'number' ||
        !Number.isInteger(item.count) ||
        item.count < 1 ||
        item.count > ASSISTANT_MAX_DRAFTS)
    )
      return null;
    let dates: AssistantDates | null = null;
    if (item.dates !== null) {
      const d = item.dates;
      if (!isRecord(d) || !exactKeys(d, ['kind', 'date', 'days'])) return null;
      if (!['today', 'tomorrow', 'date', 'each_day'].includes(d.kind as string)) return null;
      if (d.date !== null && (typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(d.date)))
        return null;
      if (
        d.days !== null &&
        (typeof d.days !== 'number' ||
          !Number.isInteger(d.days) ||
          d.days < 1 ||
          d.days > ASSISTANT_MAX_DAYS)
      )
        return null;
      if (d.kind === 'date' && d.date === null) return null;
      dates = {
        kind: d.kind as AssistantDates['kind'],
        date: d.date as string | null,
        days: d.days as number | null
      };
    }
    if (item.base !== null && item.base !== 'offer_defaults' && item.base !== 'copy_of_row')
      return null;
    if (
      item.baseRow !== null &&
      (typeof item.baseRow !== 'number' || !Number.isInteger(item.baseRow) || item.baseRow < 1)
    )
      return null;
    if (
      !Array.isArray(item.rows) ||
      item.rows.length > ASSISTANT_MAX_DRAFTS ||
      !item.rows.every(
        row =>
          typeof row === 'number' &&
          Number.isInteger(row) &&
          row >= 1 &&
          row <= ASSISTANT_MAX_DRAFTS
      )
    )
      return null;
    if (!Array.isArray(item.fields) || item.fields.length > ASSISTANT_MAX_FIELDS) return null;
    const fields = item.fields.map(parseChange);
    if (fields.some(change => change === null)) return null;
    if (!Array.isArray(item.overrides) || item.overrides.length > ASSISTANT_MAX_DRAFTS) return null;
    const overrides: AssistantAction['overrides'] = [];
    for (const override of item.overrides) {
      if (!isRecord(override) || !exactKeys(override, ['account', 'fields'])) return null;
      if (
        typeof override.account !== 'string' ||
        override.account.length === 0 ||
        override.account.length > 60
      )
        return null;
      if (!Array.isArray(override.fields) || override.fields.length > ASSISTANT_MAX_FIELDS)
        return null;
      const changes = override.fields.map(parseChange);
      if (changes.some(change => change === null)) return null;
      overrides.push({ account: override.account, fields: changes as AssistantFieldChange[] });
    }
    // A question is only words on buttons: an overlong one is cut, one without two real options
    // is dropped — it never cost the person a plan that was otherwise fine.
    let question: AssistantAction['question'] = null;
    if (item.question !== null) {
      const q = item.question;
      if (!isRecord(q) || !exactKeys(q, ['about', 'options'])) return null;
      if (typeof q.about !== 'string' || !Array.isArray(q.options)) return null;
      if (!q.options.every(option => typeof option === 'string')) return null;
      const options = (q.options as string[])
        .map(option => option.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 5);
      if (q.about.trim() && options.length >= 2)
        question = { about: q.about.trim().slice(0, 300), options };
    }
    if (item.type === 'ask' && question === null) continue;
    parsed.push({
      type: item.type as AssistantActionType,
      offer: item.offer as string | null,
      accounts: item.accounts as string[],
      count: item.count as number | null,
      dates,
      base: item.base as AssistantAction['base'],
      baseRow: item.baseRow as number | null,
      rows: item.rows as number[],
      fields: fields as AssistantFieldChange[],
      overrides,
      question,
      notesFrom: notesFrom as string | null,
      notesLanguage: notesLanguage as string | null,
      includeLaunched,
      tool: tool as string | null,
      args
    });
  }
  return { reply: reply.slice(0, ASSISTANT_REPLY_MAX), actions: parsed };
}

// -------------------------------------------------------------------------------------------
// Short replies without a model

export type AssistantQuickIntent = 'review_today' | 'review' | 'undo' | 'yes' | 'no';

const QUICK: ReadonlyArray<[AssistantQuickIntent, RegExp]> = [
  ['review_today', /^(запуск(ай|ати)|запусти)\s+(всі|усі|все)\s+(на\s+)?сьогодні[.!]*$/iu],
  [
    'review',
    /^(запускай|запускаємо|запусти(\s+(їх|всі|усі|все))?|покажи(\s+(їх|всі|усі|все))?|переглянути)[.!]*$/iu
  ],
  ['undo', /^(скасуй|скасувати|відміни|відмінити)(\s+(це|останнє|останню))?[.!]*$/iu],
  ['yes', /^(так|да|ок|окей|ага|yes)[.!]*$/iu],
  ['no', /^(ні|нет|no|не треба)[.!]*$/iu]
];

/**
 * The intent of a short reply Soty handles itself, free and without a model. «запускай» only
 * shows the review card: it never starts generation.
 */
export function quickAssistantIntent(text: string): AssistantQuickIntent | null {
  const normalized = text.trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0 || normalized.length > 40) return null;
  for (const [intent, pattern] of QUICK) if (pattern.test(normalized)) return intent;
  return null;
}

// -------------------------------------------------------------------------------------------
// Resolving what people write

const LATIN: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ie',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'iu',
  я: 'ia',
  ы: 'y',
  э: 'e',
  ё: 'io',
  ъ: ''
};

/** Lower-case, Cyrillic transliterated, only letters and digits: «Про Капс» → «prokaps». */
export function assistantKey(text: string): string {
  return [...text.toLowerCase()]
    .map(char => LATIN[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/gu, '')
    .replace(/kh/gu, 'k')
    .replace(/h/gu, 'g')
    .replace(/c/gu, 'k');
}

const ORDINALS: Readonly<Record<string, number>> = {
  перш: 1,
  друг: 2,
  трет: 3,
  четверт: 4,
  "п'ят": 5,
  пʼят: 5,
  пят: 5,
  шост: 6,
  сьом: 7,
  восьм: 8,
  дев: 9,
  десят: 10,
  одинадцят: 11,
  дванадцят: 12,
  тринадцят: 13,
  чотирнадцят: 14,
  "п'ятнадцят": 15,
  пʼятнадцят: 15,
  пятнадцят: 15,
  шістнадцят: 16,
  сімнадцят: 17,
  вісімнадцят: 18,
  "дев'ятнадцят": 19,
  девʼятнадцят: 19,
  девятнадцят: 19,
  двадцят: 20,
  "двадцять п'ят": 25,
  двадцятьпят: 25
};

/** A number written as digits or a Ukrainian ordinal («шістнадцяте» → 16), else null. */
export function assistantNumber(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  const digits = /\d+/u.exec(trimmed);
  if (digits) return Number(digits[0]);
  const stems = Object.keys(ORDINALS).sort((a, b) => b.length - a.length);
  for (const stem of stems) if (trimmed.startsWith(stem)) return ORDINALS[stem]!;
  return null;
}

export interface AssistantCandidate {
  id: string;
  name: string;
}

export type AssistantMatch =
  | { kind: 'one'; candidate: AssistantCandidate }
  | { kind: 'many'; candidates: AssistantCandidate[] }
  | { kind: 'none' };

function stem(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/u, '');
}

/**
 * Matches what a person wrote against names in the space: exact key first, then a material alias
 * by its number («TR 16», «16», «шістнадцяте» against «TR_16.mp4»), then a unique prefix.
 * Ambiguity is returned, never guessed.
 */
export function matchAssistantName(
  written: string,
  candidates: readonly AssistantCandidate[]
): AssistantMatch {
  const key = assistantKey(written);
  if (!key) return { kind: 'none' };
  const keyed = candidates.map(candidate => ({
    candidate,
    key: assistantKey(stem(candidate.name))
  }));
  const exact = keyed.filter(item => item.key === key);
  if (exact.length === 1) return { kind: 'one', candidate: exact[0]!.candidate };
  if (exact.length > 1)
    return { kind: 'many', candidates: exact.map(item => item.candidate).slice(0, 5) };
  const number = assistantNumber(written);
  if (number !== null) {
    // «шістнадцяте» names only the number; «TR 16» also names the prefix.
    const letters = /\d/u.test(written) ? key.replace(/[0-9]+/gu, '') : '';
    const byNumber = keyed.filter(item => {
      const match = /^([a-z]*)0*([0-9]+)$/u.exec(item.key);
      return (
        match !== null && Number(match[2]) === number && (letters === '' || match[1] === letters)
      );
    });
    if (byNumber.length === 1) return { kind: 'one', candidate: byNumber[0]!.candidate };
    if (byNumber.length > 1)
      return { kind: 'many', candidates: byNumber.map(item => item.candidate).slice(0, 5) };
  }
  const prefixed = keyed.filter(item => key.length >= 3 && item.key.startsWith(key));
  if (prefixed.length === 1) return { kind: 'one', candidate: prefixed[0]!.candidate };
  if (prefixed.length > 1)
    return { kind: 'many', candidates: prefixed.map(item => item.candidate).slice(0, 5) };
  // A name written by ear: «провелік» is Proveliq, «простовія» is Prostavia. Never for a name with
  // a number — TR 16 is not TR 18.
  if (/\d/u.test(written)) return { kind: 'none' };
  const loose = looseKey(key);
  if (loose.length < 4) return { kind: 'none' };
  const allowed = Math.max(1, Math.floor(loose.length / 5));
  const near = keyed
    .map(item => {
      const other = looseKey(item.key);
      return {
        candidate: item.candidate,
        distance: Math.min(
          editDistance(loose, other),
          editDistance(loose, other.slice(0, loose.length))
        )
      };
    })
    .filter(item => item.distance <= allowed)
    .sort((a, b) => a.distance - b.distance);
  if (near.length === 0) return { kind: 'none' };
  const best = near.filter(item => item.distance === near[0]!.distance);
  if (best.length === 1) return { kind: 'one', candidate: best[0]!.candidate };
  return { kind: 'many', candidates: best.map(item => item.candidate).slice(0, 5) };
}

/** Spelling transliteration cannot settle: q/k, x/ks, w/v, y/i, doubled letters. */
function looseKey(key: string): string {
  return key
    .replace(/q/gu, 'k')
    .replace(/x/gu, 'ks')
    .replace(/w/gu, 'v')
    .replace(/[yj]/gu, 'i')
    .replace(/ph/gu, 'f')
    .replace(/(.)\1+/gu, '$1');
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** Links a person pasted become ⟦url:N⟧ before the text reaches the model; values stay on the server. */
export function extractAssistantUrls(text: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  const replaced = text.replace(/https?:\/\/[^\s<>"'«»]+/giu, match => {
    const clean = match.replace(/[.,;:!?)\]]+$/u, '');
    const tail = match.slice(clean.length);
    let index = urls.indexOf(clean);
    if (index < 0) {
      if (urls.length >= 50) return match;
      urls.push(clean);
      index = urls.length - 1;
    }
    return `⟦url:${index + 1}⟧${tail}`;
  });
  return { text: replaced, urls };
}

/** The URL a ⟦url:N⟧ marker stands for, or null for anything else. */
export function assistantUrlSlot(value: unknown, urls: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  const match = /^⟦url:(\d{1,2})⟧$/u.exec(value.trim());
  if (!match) return null;
  return urls[Number(match[1]) - 1] ?? null;
}

// -------------------------------------------------------------------------------------------
// Cards the server builds

export interface AssistantRow {
  /** 1-based position in this card; «у другому» means 2. */
  n: number;
  launchId: string;
  version: string;
  account: string | null;
  offer: string | null;
  creatives: string[];
  launchDate: string | null;
  campaignCount: number | null;
  productCount: number | null;
  budget: string | null;
  url: boolean;
  r2: boolean | null;
  /** Fields that are still missing or blocked, as registry paths with a reason code. */
  blocked: Array<{ field: string; code: string }>;
}

export interface AssistantResultPayload {
  rows: AssistantRow[];
  /** Explicit values that differ from the offer profile, as «field: profile → value». */
  differences: Array<{ field: string; from: string | null; to: string }>;
  unresolved: Array<{ field: string; written: string; code: string }>;
  profile: {
    offer: string;
    changes: Array<{ field: string; from: string | null; to: string }>;
  } | null;
  campaigns: number;
  date: string | null;
}

export interface AssistantQuestionPayload {
  about: string;
  options: Array<{ id: string; label: string }>;
}

export interface AssistantReviewPayload {
  date: string | null;
  timezone: string | null;
  rows: AssistantRow[];
  ready: number;
  truncated: boolean;
  batchKey?: string;
}

export interface AssistantProfilePayload {
  offerId: string;
  offer: string;
  changes: Array<{ field: string; from: string | null; to: string }>;
}

export interface AssistantRefusalPayload {
  code: string;
  details?: Record<string, unknown>;
}

export type AssistantCardKind =
  | 'result'
  | 'question'
  | 'review'
  | 'status'
  | 'profile'
  | 'refusal'
  /** An answer read from the space: a title, columns, rows, an optional total. */
  | 'table';

export interface AssistantCard {
  id: string;
  kind: AssistantCardKind;
  state: 'open' | 'answered' | 'confirmed' | 'launched' | 'stale' | 'undone';
  commandId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AssistantMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  price: number;
  commandId: string | null;
  createdAt: string;
  cards: AssistantCard[];
}

const CARD_KINDS: readonly AssistantCardKind[] = [
  'result',
  'question',
  'review',
  'status',
  'profile',
  'refusal',
  'table'
];
const CARD_STATES = ['open', 'answered', 'confirmed', 'launched', 'stale', 'undone'];

export function parseAssistantMessage(value: unknown): AssistantMessage | null {
  if (!isRecord(value)) return null;
  const { id, role, text, price, commandId, createdAt, cards } = value;
  if (
    typeof id !== 'number' ||
    (role !== 'user' && role !== 'assistant') ||
    typeof text !== 'string' ||
    typeof price !== 'number' ||
    (commandId !== null && typeof commandId !== 'string') ||
    typeof createdAt !== 'string' ||
    !Array.isArray(cards)
  )
    return null;
  const parsed: AssistantCard[] = [];
  for (const card of cards) {
    if (
      !isRecord(card) ||
      typeof card.id !== 'string' ||
      !CARD_KINDS.includes(card.kind as AssistantCardKind) ||
      !CARD_STATES.includes(card.state as string) ||
      (card.commandId !== null && typeof card.commandId !== 'string') ||
      !isRecord(card.payload) ||
      typeof card.createdAt !== 'string'
    )
      return null;
    parsed.push({
      id: card.id,
      kind: card.kind as AssistantCardKind,
      state: card.state as AssistantCard['state'],
      commandId: card.commandId as string | null,
      payload: card.payload,
      createdAt: card.createdAt
    });
  }
  return { id, role, text, price, commandId: commandId as string | null, createdAt, cards: parsed };
}

/** Machine codes the assistant answers with. The UI localises them; nothing parses provider text. */
export const ASSISTANT_REASONS = [
  'ASSISTANT_DISABLED',
  'ASSISTANT_FORBIDDEN',
  'MESSAGE_TOO_LONG',
  'MODEL_UNAVAILABLE',
  'MODEL_OUTPUT_REJECTED',
  'PLAN_TOO_LARGE',
  'REVIEW_CHANGED',
  'EDIT_CONFLICT',
  'KEY_REUSED',
  'NOT_FOUND',
  'NO_CONTEXT_CARD',
  'FIELD_FORM_ONLY',
  'FIELD_NOT_SUPPORTED',
  'INVALID_VALUE',
  'OFFER_NOT_FOUND',
  'ACCOUNT_NOT_FOUND',
  'MATERIAL_NOT_FOUND',
  'AMBIGUOUS',
  'DEFAULTS_FORBIDDEN',
  'LAUNCHED',
  'CHANGED_AFTER',
  'FIELD_CHANGED'
] as const;
export type AssistantReason = (typeof ASSISTANT_REASONS)[number];
