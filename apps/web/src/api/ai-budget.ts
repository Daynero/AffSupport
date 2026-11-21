/**
 * 064: the admin's AI budget. Every function checks public.is_admin() on the server; the UI only
 * shows what came back.
 */
import { requireSupabaseClient, withFreshSession } from '../lib/supabase.js';
import { TeamApiError, throwRpc } from './team.js';

export interface AiBudgetFeature {
  feature: 'transcript_translation' | 'launch_assistant';
  spentUsd: number;
  chargedCredits: number;
  coverage: number | null;
  unknownCalls: number;
}

export interface AiBudgetOverview {
  month: string;
  day: string;
  daysInMonth: number;
  fullDays: number;
  limitUsd: number;
  spentUsd: number;
  heldUsd: number;
  freeUsd: number;
  forecastUsd: number | null;
  fullGrantUseUsd: number;
  byFeature: AiBudgetFeature[];
  creditUsd: number;
  baseDailyGrant: number;
  assistantEnabled: boolean;
  grants: Array<{ email: string; dailyGrant: number }>;
  updatedAt: string;
}

export interface AiPilotSpace {
  teamId: string;
  name: string;
  pilot: boolean;
}

const num = (value: unknown) =>
  typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;

export function parseAiBudgetOverview(value: unknown): AiBudgetOverview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const numbers = [
    'daysInMonth',
    'fullDays',
    'limitUsd',
    'spentUsd',
    'heldUsd',
    'freeUsd',
    'fullGrantUseUsd',
    'creditUsd',
    'baseDailyGrant'
  ];
  if (numbers.some(key => !Number.isFinite(num(v[key])))) return null;
  if (typeof v.month !== 'string' || typeof v.day !== 'string' || typeof v.updatedAt !== 'string')
    return null;
  if (
    !Array.isArray(v.byFeature) ||
    !Array.isArray(v.grants) ||
    typeof v.assistantEnabled !== 'boolean'
  )
    return null;
  return {
    month: v.month,
    day: v.day,
    daysInMonth: num(v.daysInMonth),
    fullDays: num(v.fullDays),
    limitUsd: num(v.limitUsd),
    spentUsd: num(v.spentUsd),
    heldUsd: num(v.heldUsd),
    freeUsd: num(v.freeUsd),
    forecastUsd: v.forecastUsd === null || v.forecastUsd === undefined ? null : num(v.forecastUsd),
    fullGrantUseUsd: num(v.fullGrantUseUsd),
    byFeature: (v.byFeature as Array<Record<string, unknown>>).map(f => ({
      feature: f.feature === 'launch_assistant' ? 'launch_assistant' : 'transcript_translation',
      spentUsd: num(f.spentUsd),
      chargedCredits: num(f.chargedCredits),
      coverage: f.coverage === null || f.coverage === undefined ? null : num(f.coverage),
      unknownCalls: num(f.unknownCalls)
    })),
    creditUsd: num(v.creditUsd),
    baseDailyGrant: num(v.baseDailyGrant),
    assistantEnabled: v.assistantEnabled,
    grants: (v.grants as Array<Record<string, unknown>>).map(g => ({
      email: String(g.email),
      dailyGrant: num(g.dailyGrant)
    })),
    updatedAt: v.updatedAt
  };
}

type AdminAiFunction =
  | 'admin_ai_budget_overview'
  | 'admin_ai_set_month_limit'
  | 'admin_ai_set_base_grant'
  | 'admin_ai_set_user_grant'
  | 'admin_ai_set_assistant_enabled'
  | 'admin_ai_assistant_spaces'
  | 'admin_ai_set_assistant_space';

type PlainRpc = (
  name: AdminAiFunction,
  args: Record<string, unknown>
) => PromiseLike<{ data: unknown; error: Parameters<typeof throwRpc>[0] }>;

async function call(name: AdminAiFunction, args: Record<string, unknown> = {}) {
  const { data, error } = await withFreshSession(() => {
    const client = requireSupabaseClient();
    return (client.rpc as unknown as PlainRpc).call(client, name, args);
  });
  throwRpc(error);
  return data;
}

function overview(value: unknown): AiBudgetOverview {
  const parsed = parseAiBudgetOverview(value);
  if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
  return parsed;
}

export const aiBudgetApi = {
  async overview() {
    return overview(await call('admin_ai_budget_overview'));
  },
  async setMonthLimit(limit: number) {
    return overview(await call('admin_ai_set_month_limit', { p_limit: limit }));
  },
  async setBaseGrant(grant: number) {
    return overview(await call('admin_ai_set_base_grant', { p_grant: grant }));
  },
  async setUserGrant(email: string, grant: number | null) {
    return overview(await call('admin_ai_set_user_grant', { p_email: email, p_grant: grant }));
  },
  async setAssistantEnabled(enabled: boolean) {
    return overview(await call('admin_ai_set_assistant_enabled', { p_enabled: enabled }));
  },
  async spaces(): Promise<AiPilotSpace[]> {
    const data = await call('admin_ai_assistant_spaces');
    return Array.isArray(data) ? (data as AiPilotSpace[]) : [];
  },
  async setSpace(teamId: string, enabled: boolean): Promise<AiPilotSpace[]> {
    const data = await call('admin_ai_set_assistant_space', { p_team: teamId, p_enabled: enabled });
    return Array.isArray(data) ? (data as AiPilotSpace[]) : [];
  }
};
