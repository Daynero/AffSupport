import {
  parseFinanceSnapshot,
  parseFinanceMutation,
  financeRecord,
  TEAM_ERROR_CODES
} from '@video-compressor/shared';
import type { FinanceMetric } from '@video-compressor/shared';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase';
import { TeamApiError } from './team';
import { publicConfig } from '../lib/config';

function check(error: { message: string } | null) {
  if (error)
    throw new TeamApiError(
      TEAM_ERROR_CODES.find(code => error.message.includes(code)) ?? 'INVALID_RESPONSE',
      false
    );
}
export const teamFinanceApi = {
  async snapshot(team: string, from: string, to: string, timezone: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_agent_finance', {
        p_team: team,
        p_from: from,
        p_to: to,
        p_timezone: timezone
      })
    );
    check(error);
    const result = parseFinanceSnapshot(data);
    if (!result || result.teamId !== team || result.from !== from || result.to !== to)
      throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async set(
    team: string,
    agent: string,
    date: string,
    metric: FinanceMetric,
    value: string | null,
    version: string,
    timezone: string,
    requestId: string
  ) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_agent_finance_value', {
        p_team: team,
        p_agent: agent,
        p_date: date,
        p_metric: metric,
        p_value: value,
        p_expected_version: version,
        p_timezone: timezone,
        p_request_id: requestId
      })
    );
    check(error);
    const result = parseFinanceMutation(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async undo(team: string, original: string, requestId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('undo_team_agent_finance_clear', {
        p_team: team,
        p_original_request_id: original,
        p_request_id: requestId
      })
    );
    check(error);
    const result = parseFinanceMutation(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async move(
    team: string,
    agent: string,
    target: string,
    date: string,
    placementId: string,
    version: string,
    timezone: string,
    requestId: string
  ) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('move_team_account_agent', {
        p_team: team,
        p_agent: agent,
        p_target_account: target,
        p_effective_on: date,
        p_expected_placement_id: placementId,
        p_expected_placement_version: version,
        p_timezone: timezone,
        p_request_id: requestId
      })
    );
    check(error);
    if (!financeRecord(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },
  async history(
    team: string,
    agent: string,
    cursor?: { time: string; id: string }
  ): Promise<Record<string, unknown>> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_agent_finance_history', {
        p_team: team,
        p_agent: agent,
        p_cursor: cursor,
        p_limit: 50
      })
    );
    check(error);
    if (!financeRecord(data) || !Array.isArray(data.events) || !Array.isArray(data.transfers))
      throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },
  async legacy(team: string, agent: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_agent_finance_legacy', {
        p_team: team,
        p_agent: agent
      })
    );
    check(error);
    if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    const rows: Record<string, unknown>[] = [];
    for (const row of data) {
      if (!financeRecord(row)) throw new TeamApiError('INVALID_RESPONSE', false);
      rows.push(row);
    }
    return rows;
  },
  async importLegacy(
    team: string,
    id: string,
    metric: 'balance' | 'topup',
    date: string,
    value: string,
    timezone: string,
    request: string
  ) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('import_team_agent_finance_legacy', {
        p_team: team,
        p_legacy: id,
        p_metric: metric,
        p_date: date,
        p_value: value,
        p_currency: 'USD',
        p_timezone: timezone,
        p_request_id: request
      })
    );
    check(error);
    const result = parseFinanceMutation(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async clear(
    team: string,
    date: string,
    metric: 'balance' | 'topup',
    fields: { agent: string; expectedVersion: string }[],
    timezone: string,
    requestId: string
  ) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('clear_team_agent_finance_values', {
        p_team: team,
        p_date: date,
        p_metric: metric,
        p_fields: fields,
        p_timezone: timezone,
        p_request_id: requestId
      })
    );
    check(error);
    const result = parseFinanceMutation(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async export(team: string, from: string, to: string, timezone: string) {
    if (!publicConfig.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    const config = publicConfig.value;
    // Source beta may run the unchanged Edge entrypoint natively when the
    // local container runtime is unavailable. Real JWT authorization remains
    // mandatory. Neither packaged beta nor production uses this dev proxy.
    const endpoint =
      import.meta.env.DEV && import.meta.env.MODE === 'beta'
        ? '/local-functions/team-finance-export'
        : `${config.supabaseUrl}/functions/v1/team-finance-export`;
    // functions.invoke parses an XLSX MIME as text in the installed SDK. Fetch
    // the binary directly with the same session and one bounded auth retry.
    const { response, error } = await withFreshSession(async () => {
      const session = await requireSupabaseClient().auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new TeamApiError('AUTH_REQUIRED', false);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          apikey: config.supabasePublishableKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ teamId: team, from, to, timezone })
      });
      return { response, error: response.ok ? null : { status: response.status } };
    });
    if (error) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        /* Non-JSON upstream failure. */
      }
      if (financeRecord(payload) && financeRecord(payload.error)) {
        const detail = payload.error;
        const code = TEAM_ERROR_CODES.find(code => code === detail.code);
        if (code) throw new TeamApiError(code, detail.retryable === true);
      }
      throw new TeamApiError('FINANCE_EXPORT_FAILED', response.status >= 500);
    }
    if (
      response.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
      throw new TeamApiError('FINANCE_EXPORT_FAILED', true);
    const data = await response.blob();
    const signature = new Uint8Array(await data.slice(0, 4).arrayBuffer());
    if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 3 || signature[3] !== 4)
      throw new TeamApiError('FINANCE_EXPORT_FAILED', true);
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url;
    link.download = `finance-${team}-${from}-${to}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};
