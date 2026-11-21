/**
 * 064: every Launch setting a person can edit, described once.
 *
 * The assistant's answer schema, the model's field guide and the server's value checks are all
 * generated from this list, so a field is either fully supported in text or not at all. A field
 * the form edits but this list does not name makes `tests/launch-field-registry.test.ts` red.
 *
 * Tier 1 is what the assistant edits from the first release. Tier 2 fields are listed (the form
 * edits them) but the assistant answers «зміни це у формі» until each one has its parity test and
 * its `assistant` flag is turned on.
 */
import { CATALOG_PRODUCT_COUNT_MAX } from '../catalog-video-set.js';
import { LAUNCH_ADS_MAX, LAUNCH_BUDGET_MAX, LAUNCH_CAMPAIGN_MAX, LAUNCH_SUB_VARIABLES, LAUNCH_URL_MAX } from '../launches.js';

export type LaunchFieldKind =
  | 'offer'
  | 'buyer'
  | 'account'
  | 'creatives'
  | 'integer'
  | 'money'
  | 'money-list'
  | 'boolean'
  | 'enum'
  | 'url'
  | 'date'
  | 'sub'
  | 'notes'
  | 'duration'
  | 'publication';

export type LaunchFieldOp = 'set' | 'clear' | 'add' | 'remove' | 'reorder';

export interface LaunchFieldSpec {
  /** Path inside LaunchConfig. */
  path: string;
  tier: 1 | 2;
  /** Whether the assistant may change it now (tier 1 always; tier 2 once its parity test exists). */
  assistant: boolean;
  kind: LaunchFieldKind;
  ops: readonly LaunchFieldOp[];
  min?: number;
  max?: number;
  values?: readonly string[];
  /** Part of an offer's saved profile (LAUNCH_DEFAULT_FIELDS or a catalog/SUB key). */
  profile: boolean;
  /** Only when the Launch method is catalog. */
  catalogOnly?: boolean;
  /** Ukrainian words people use for it; part of the model's field guide. */
  words: readonly string[];
  /** One line for the model: what the value means. */
  note: string;
}

const COUNT = ['set'] as const;
const OPTIONAL = ['set', 'clear'] as const;

export const LAUNCH_FIELDS: readonly LaunchFieldSpec[] = [
  { path: 'offerId', tier: 1, assistant: true, kind: 'offer', ops: COUNT, profile: false, words: ['офер', 'оффер', 'продукт'], note: 'offer name as the person wrote it' },
  { path: 'buyerId', tier: 1, assistant: true, kind: 'buyer', ops: OPTIONAL, profile: true, words: ['баєр', 'байєр', 'buyer'], note: 'buyer name as written' },
  { path: 'agentRowId', tier: 1, assistant: true, kind: 'account', ops: COUNT, profile: false, words: ['РК', 'рекламний акаунт', 'акаунт', 'кабінет'], note: 'ad account label such as G2' },
  { path: 'creatives', tier: 1, assistant: true, kind: 'creatives', ops: ['set', 'add', 'remove', 'reorder'], profile: false, words: ['відео', 'креатив', 'креативи', 'картинка', 'матеріал'], note: 'material names such as TR_16, in order' },
  { path: 'campaignCount', tier: 1, assistant: true, kind: 'integer', ops: COUNT, min: 1, max: LAUNCH_CAMPAIGN_MAX, profile: true, words: ['кампанії', 'кампаній', 'кампанія'], note: 'campaigns inside one launch' },
  { path: 'adsCount', tier: 1, assistant: true, kind: 'integer', ops: COUNT, min: 1, max: LAUNCH_ADS_MAX, profile: true, words: ['оголошення', 'адсів', 'ads'], note: 'ads per campaign' },
  { path: 'budgetMode', tier: 1, assistant: true, kind: 'enum', ops: COUNT, values: ['auto', 'single', 'manual'], profile: true, words: ['режим бюджету'], note: 'auto = spread between min and max, single = one sum for every campaign, manual = a sum per campaign' },
  { path: 'minBudget', tier: 1, assistant: true, kind: 'money', ops: COUNT, min: 0, max: LAUNCH_BUDGET_MAX, profile: true, words: ['мінімальний бюджет', 'від'], note: 'auto mode lower bound, USD per campaign' },
  { path: 'maxBudget', tier: 1, assistant: true, kind: 'money', ops: COUNT, min: 1, max: LAUNCH_BUDGET_MAX, profile: true, words: ['максимальний бюджет', 'до', 'бюджет'], note: 'auto mode upper bound; in single mode the one sum per campaign' },
  { path: 'budgets', tier: 1, assistant: true, kind: 'money-list', ops: ['set', 'clear'], min: 1, max: LAUNCH_BUDGET_MAX, profile: true, words: ['бюджети кампаній'], note: 'manual mode: one sum per campaign, in order' },
  { path: 'catalog.productCount', tier: 1, assistant: true, kind: 'integer', ops: COUNT, min: 1, max: CATALOG_PRODUCT_COUNT_MAX, profile: true, catalogOnly: true, words: ['товари', 'товарів', 'продуктів', 'позицій'], note: 'products in the catalog' },
  { path: 'originalUrl', tier: 1, assistant: true, kind: 'url', ops: OPTIONAL, max: LAUNCH_URL_MAX, profile: true, words: ['посилання', 'лінк', 'url', 'урл'], note: 'a pasted link; refer to it by its ⟦url:N⟧ marker' },
  { path: 'subConfig.sub1', tier: 1, assistant: true, kind: 'sub', ops: ['set', 'clear', 'add', 'remove', 'reorder'], values: LAUNCH_SUB_VARIABLES, profile: true, words: ['sub1', 'саб1', 'суб1'], note: 'variables joined into sub1' },
  { path: 'subConfig.sub2', tier: 1, assistant: true, kind: 'sub', ops: ['set', 'clear', 'add', 'remove', 'reorder'], values: LAUNCH_SUB_VARIABLES, profile: true, words: ['sub2', 'саб2', 'суб2'], note: 'variables joined into sub2' },
  { path: 'subConfig.sub3', tier: 1, assistant: true, kind: 'sub', ops: ['set', 'clear', 'add', 'remove', 'reorder'], values: LAUNCH_SUB_VARIABLES, profile: true, words: ['sub3', 'саб3', 'суб3'], note: 'variables joined into sub3' },
  { path: 'launchDate', tier: 1, assistant: true, kind: 'date', ops: COUNT, profile: true, words: ['дата', 'на сьогодні', 'на завтра', 'день'], note: 'YYYY-MM-DD or today/tomorrow' },
  { path: 'catalog.copyVideoToR2', tier: 1, assistant: true, kind: 'boolean', ops: COUNT, profile: true, catalogOnly: true, words: ['R2', 'копіювати в R2', 'скопіюй у R2'], note: 'copy the catalog video to R2' },
  { path: 'catalog.restitchEnabled', tier: 1, assistant: true, kind: 'boolean', ops: COUNT, profile: true, catalogOnly: true, words: ['перезашивка', 'перешити', 'ре-стіч'], note: 're-stitch the video for the catalog' },
  { path: 'method', tier: 2, assistant: false, kind: 'enum', ops: COUNT, values: ['catalog', 'other'], profile: true, words: ['метод', 'каталог', 'інший метод'], note: 'catalog or another method' },
  { path: 'age', tier: 2, assistant: false, kind: 'integer', ops: COUNT, min: 13, max: 65, profile: true, words: ['вік'], note: 'minimum age' },
  { path: 'gender', tier: 2, assistant: false, kind: 'enum', ops: COUNT, values: ['M', 'W', 'ALL'], profile: true, words: ['стать', 'чоловіки', 'жінки'], note: 'audience gender' },
  { path: 'advantagePlus', tier: 2, assistant: false, kind: 'boolean', ops: COUNT, profile: true, words: ['Advantage+', 'адвантаж'], note: 'Advantage+ audience' },
  { path: 'notes', tier: 2, assistant: false, kind: 'notes', ops: ['set', 'clear', 'add', 'remove'], profile: true, words: ['нотатка', 'нотатки'], note: 'notes on the launch' },
  { path: 'catalog.finalDurationMode', tier: 2, assistant: false, kind: 'duration', ops: COUNT, values: ['random-30-40', 'random-40-50', 'random-50-60', 'random-centered', 'custom'], profile: true, catalogOnly: true, words: ['тривалість'], note: 'final video length' },
  { path: 'catalog.customFinalDurationSeconds', tier: 2, assistant: false, kind: 'integer', ops: OPTIONAL, min: 1, max: 600, profile: true, catalogOnly: true, words: ['секунд'], note: 'custom final length' },
  { path: 'catalog.finalDurationRangeSeconds', tier: 2, assistant: false, kind: 'duration', ops: OPTIONAL, profile: true, catalogOnly: true, words: ['діапазон тривалості'], note: 'random length bounds' },
  { path: 'catalog.videoVariationCount', tier: 2, assistant: false, kind: 'integer', ops: OPTIONAL, min: 1, max: CATALOG_PRODUCT_COUNT_MAX, profile: true, catalogOnly: true, words: ['варіації', 'варіацій відео'], note: 'distinct video variations' },
  { path: 'catalog.videoPublication', tier: 2, assistant: false, kind: 'publication', ops: OPTIONAL, profile: true, catalogOnly: true, words: ['публікація', 'розклад'], note: 'when the catalog video is published' }
];

const BY_PATH = new Map(LAUNCH_FIELDS.map(field => [field.path, field]));

export function launchField(path: string): LaunchFieldSpec | null {
  return BY_PATH.get(path) ?? null;
}

/** Paths the assistant may change today. */
export function assistantFieldPaths(): string[] {
  return LAUNCH_FIELDS.filter(field => field.assistant).map(field => field.path);
}

/** The model's field guide: one line per field it may use. Part of the cached prompt prefix. */
export function launchFieldGuide(): string {
  return LAUNCH_FIELDS.filter(field => field.assistant)
    .map(field => {
      const range =
        field.values !== undefined
          ? ` one of ${field.values.join('|')}`
          : field.min !== undefined || field.max !== undefined
            ? ` ${field.min ?? ''}..${field.max ?? ''}`
            : '';
      return `- ${field.path} (${field.kind}${range}; ops ${field.ops.join('/')}): ${field.note}. Words: ${field.words.join(', ')}.`;
    })
    .join('\n');
}

export type LaunchFieldCheck =
  | { ok: true; value: unknown }
  | { ok: false; code: 'FIELD_NOT_SUPPORTED' | 'FIELD_FORM_ONLY' | 'INVALID_VALUE' | 'OP_NOT_ALLOWED' };

/**
 * Checks one scalar value the assistant proposed for one field. References (offer, buyer, account,
 * creatives) and URLs are resolved by the server elsewhere; here they pass through as strings.
 */
export function checkLaunchFieldValue(path: string, op: LaunchFieldOp, raw: unknown): LaunchFieldCheck {
  const field = launchField(path);
  if (!field) return { ok: false, code: 'FIELD_NOT_SUPPORTED' };
  if (!field.assistant) return { ok: false, code: 'FIELD_FORM_ONLY' };
  if (!field.ops.includes(op)) return { ok: false, code: 'OP_NOT_ALLOWED' };
  if (op === 'clear') return { ok: true, value: undefined };
  const within = (value: number) =>
    (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
  switch (field.kind) {
    case 'integer':
      return typeof raw === 'number' && Number.isInteger(raw) && within(raw)
        ? { ok: true, value: raw }
        : { ok: false, code: 'INVALID_VALUE' };
    case 'money':
      return typeof raw === 'number' && Number.isFinite(raw) && within(raw) && Math.round(raw * 100) === raw * 100
        ? { ok: true, value: raw }
        : { ok: false, code: 'INVALID_VALUE' };
    case 'money-list':
      return Array.isArray(raw) &&
        raw.length >= 1 &&
        raw.length <= LAUNCH_CAMPAIGN_MAX &&
        raw.every(item => typeof item === 'number' && Number.isFinite(item) && within(item))
        ? { ok: true, value: raw }
        : { ok: false, code: 'INVALID_VALUE' };
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, code: 'INVALID_VALUE' };
    case 'enum':
      return typeof raw === 'string' && (field.values ?? []).includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, code: 'INVALID_VALUE' };
    case 'sub': {
      const list = op === 'add' || op === 'remove' ? (typeof raw === 'string' ? [raw] : raw) : raw;
      return Array.isArray(list) &&
        list.length <= LAUNCH_SUB_VARIABLES.length &&
        list.every(item => typeof item === 'string' && (field.values ?? []).includes(item))
        ? { ok: true, value: list }
        : { ok: false, code: 'INVALID_VALUE' };
    }
    case 'date':
      return typeof raw === 'string' && (/^\d{4}-\d{2}-\d{2}$/u.test(raw) || raw === 'today' || raw === 'tomorrow')
        ? { ok: true, value: raw }
        : { ok: false, code: 'INVALID_VALUE' };
    case 'offer':
    case 'buyer':
    case 'account':
    case 'url':
      return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= (field.max ?? 200)
        ? { ok: true, value: raw.trim() }
        : { ok: false, code: 'INVALID_VALUE' };
    case 'creatives': {
      const list = typeof raw === 'string' ? [raw] : raw;
      return Array.isArray(list) &&
        list.length >= 1 &&
        list.length <= 50 &&
        list.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 200)
        ? { ok: true, value: list.map(item => (item as string).trim()) }
        : { ok: false, code: 'INVALID_VALUE' };
    }
    default:
      return { ok: false, code: 'FIELD_FORM_ONLY' };
  }
}
