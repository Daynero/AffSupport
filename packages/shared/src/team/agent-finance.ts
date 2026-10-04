export type FinanceMetric = 'balance' | 'topup' | 'spend';
export const FINANCE_METRICS: readonly FinanceMetric[] = ['balance', 'topup', 'spend'];
export const FINANCE_AMOUNT_MAX = 99_999_999_999n;
export function parseFinanceMoney(value: unknown): bigint | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(',', '.');
  if (!text) return null;
  if (!/^\d{1,9}(?:\.\d{1,2})?$/u.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= FINANCE_AMOUNT_MAX ? cents : undefined;
}
export function financeMoney(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
export function validFinanceDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validFinanceTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export function financeToday(timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export interface FinancePlacement {
  id: string;
  agentRowId: string;
  accountId: string;
  startsOn: string;
  endsOn: string | null;
  version: string;
}
export interface FinanceField {
  agentRowId: string;
  date: string;
  metric: FinanceMetric;
  value: string | null;
  currency: 'USD';
  version: string;
  placementId: string;
  updatedAt: string;
  updatedBy: string | null;
}
export interface FinanceSnapshot {
  schemaVersion: 1;
  teamId: string;
  teamName: string;
  from: string;
  to: string;
  currency: 'USD';
  generatedAt: string;
  accounts: { id: string; name: string }[];
  agents: { id: string; agentId: string }[];
  placements: FinancePlacement[];
  fields: FinanceField[];
}
export interface FinanceMutation {
  requestId: string;
  fields: FinanceField[];
  undoReference: string | null;
}
export function financeRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const string = (v: unknown): v is string => typeof v === 'string';
const version = (v: unknown): v is string => string(v) && /^\d+$/u.test(v);
export function isFinanceField(v: unknown): v is FinanceField {
  if (!financeRecord(v)) return false;
  return (
    string(v.agentRowId) &&
    validFinanceDate(v.date) &&
    FINANCE_METRICS.some(m => m === v.metric) &&
    (v.value === null ||
      (string(v.value) &&
        /^\d{1,9}\.\d{2}$/u.test(v.value) &&
        parseFinanceMoney(v.value) !== undefined)) &&
    v.currency === 'USD' &&
    version(v.version) &&
    string(v.placementId) &&
    string(v.updatedAt) &&
    (v.updatedBy === null || string(v.updatedBy))
  );
}
export function parseFinanceSnapshot(v: unknown): FinanceSnapshot | null {
  if (
    !financeRecord(v) ||
    v.schemaVersion !== 1 ||
    !string(v.teamId) ||
    !string(v.teamName) ||
    !validFinanceDate(v.from) ||
    !validFinanceDate(v.to) ||
    v.currency !== 'USD' ||
    !string(v.generatedAt)
  )
    return null;
  if (
    !Array.isArray(v.accounts) ||
    !v.accounts.every(a => financeRecord(a) && string(a.id) && string(a.name))
  )
    return null;
  if (
    !Array.isArray(v.agents) ||
    !v.agents.every(a => financeRecord(a) && string(a.id) && string(a.agentId))
  )
    return null;
  if (
    !Array.isArray(v.placements) ||
    !v.placements.every(
      p =>
        financeRecord(p) &&
        string(p.id) &&
        string(p.agentRowId) &&
        string(p.accountId) &&
        validFinanceDate(p.startsOn) &&
        (p.endsOn === null || validFinanceDate(p.endsOn)) &&
        version(p.version)
    )
  )
    return null;
  if (!Array.isArray(v.fields) || !v.fields.every(isFinanceField)) return null;
  if (v.from > v.to || new Date(v.to).getTime() - new Date(v.from).getTime() > 365 * 86400000)
    return null;
  const accounts = new Set(v.accounts.map(a => a.id));
  const agents = new Set(v.agents.map(a => a.id));
  if (accounts.size !== v.accounts.length || agents.size !== v.agents.length) return null;
  const placements = new Map(v.placements.map(p => [p.id, p]));
  if (
    placements.size !== v.placements.length ||
    v.placements.some(
      p =>
        !accounts.has(p.accountId) ||
        !agents.has(p.agentRowId) ||
        (p.endsOn !== null && p.endsOn <= p.startsOn)
    )
  )
    return null;
  const fields = new Set<string>();
  for (const field of v.fields) {
    const placement = placements.get(field.placementId);
    const key = `${field.agentRowId}/${field.date}/${field.metric}`;
    if (
      !placement ||
      placement.agentRowId !== field.agentRowId ||
      field.date < placement.startsOn ||
      (placement.endsOn !== null && field.date >= placement.endsOn) ||
      field.date < v.from ||
      field.date > v.to ||
      fields.has(key)
    )
      return null;
    fields.add(key);
  }
  // All nested values are narrowed above, including every money/date boundary.
  return {
    schemaVersion: 1,
    teamId: v.teamId,
    teamName: v.teamName,
    from: v.from,
    to: v.to,
    currency: 'USD',
    generatedAt: v.generatedAt,
    accounts: v.accounts.map(a => ({ id: a.id, name: a.name })),
    agents: v.agents.map(a => ({ id: a.id, agentId: a.agentId })),
    placements: v.placements.map(p => ({
      id: p.id,
      agentRowId: p.agentRowId,
      accountId: p.accountId,
      startsOn: p.startsOn,
      endsOn: p.endsOn,
      version: p.version
    })),
    fields: v.fields
  };
}
export function parseFinanceMutation(v: unknown): FinanceMutation | null {
  if (
    !financeRecord(v) ||
    !string(v.requestId) ||
    !Array.isArray(v.fields) ||
    !v.fields.every(isFinanceField) ||
    !(v.undoReference === null || string(v.undoReference))
  )
    return null;
  return { requestId: v.requestId, fields: v.fields, undoReference: v.undoReference };
}
