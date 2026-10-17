import {
  isRecord,
  parseLaunchDetail,
  parseLaunchSummary,
  parseLaunchSources,
  parseLaunchDraft,
  parseLaunchSubConfig,
  type LaunchDetail,
  type LaunchDraft,
  type LaunchSourceSnapshot,
  type LaunchSummary,
  type LaunchOverrides,
  parseTeamAccount,
  parseTeamRestitchDefaults,
  parseRestitchDrawResult,
  LAUNCH_GENERATION_STATES,
  TEAM_ERROR_CODES
} from '@video-compressor/shared';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase';
import type { Json } from '../lib/database.types';
import { TeamApiError, invokeTeamFunction, throwRpc } from './team';
function isJson(value: unknown): value is Json {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isJson)) ||
    (isRecord(value) && Object.values(value).every(v => v === undefined || isJson(v)))
  );
}
function wire(value: unknown): Json {
  if (!isJson(value)) throw new TeamApiError('INVALID_INPUT', false);
  return value;
}
function mutation(value: unknown): { id: string; version: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.version !== 'string')
    throw new TeamApiError('INVALID_RESPONSE', false);
  return { id: value.id, version: value.version };
}
export interface LaunchDictionaryItem {
  id: string;
  value: string;
  updatedAt: string;
}
function dictionary(value: unknown): LaunchDictionaryItem[] {
  if (!Array.isArray(value)) throw new TeamApiError('INVALID_RESPONSE', false);
  return value.map(row => {
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      typeof row.value !== 'string' ||
      typeof row.updatedAt !== 'string'
    )
      throw new TeamApiError('INVALID_RESPONSE', false);
    return { id: row.id, value: row.value, updatedAt: row.updatedAt };
  });
}
function restitchPreparation(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.processKey !== 'string' ||
    (value.operationId !== null && typeof value.operationId !== 'string')
  )
    throw new TeamApiError('INVALID_RESPONSE', false);
  const defaults = parseTeamRestitchDefaults(value.defaults);
  const draw = parseRestitchDrawResult(value.draw);
  if (!defaults.ok || !draw.ok) throw new TeamApiError('INVALID_RESPONSE', false);
  return {
    defaults: defaults.value,
    draw: draw.value,
    processKey: value.processKey,
    operationId: value.operationId
  };
}
export const launchApi = {
  async retryGeneration(teamId: string, generationId: string, key: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('retry_launch_generation', {
        p_team: teamId,
        p_generation: generationId,
        p_key: key
      })
    );
    throwRpc(error);
    if (!isRecord(data) || data.generationId !== generationId || data.state !== 'accepted')
      throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },
  async pauseRestitch(
    teamId: string,
    generationId: string,
    code: 'AGENT_REQUIRED' | 'AGENT_UPDATE_REQUIRED'
  ) {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('pause_launch_restitch', {
        p_team: teamId,
        p_generation: generationId,
        p_code: code
      })
    );
    throwRpc(error);
  },
  async restitchReuse(teamId: string, generationId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_launch_restitch_reuse', {
        p_team: teamId,
        p_generation: generationId
      })
    );
    throwRpc(error);
    if (data === null) return null;
    if (
      !isRecord(data) ||
      typeof data.operationId !== 'string' ||
      typeof data.materialId !== 'string'
    )
      throw new TeamApiError('INVALID_RESPONSE', false);
    return { operationId: data.operationId, materialId: data.materialId };
  },
  async prepareRestitch(teamId: string, generationId: string, exclude: readonly string[] = []) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('prepare_launch_restitch', {
        p_team: teamId,
        p_generation: generationId,
        p_exclude: [...exclude]
      })
    );
    throwRpc(error);
    if (isRecord(data) && 'errorCode' in data) {
      const code = TEAM_ERROR_CODES.find(value => value === data.errorCode);
      throw new TeamApiError(code ?? 'INVALID_RESPONSE', false);
    }
    return restitchPreparation(data);
  },
  async restitchPreparation(teamId: string, generationId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_launch_restitch_preparation', {
        p_team: teamId,
        p_generation: generationId
      })
    );
    throwRpc(error);
    return data === null ? null : restitchPreparation(data);
  },
  async bindRestitch(teamId: string, generationId: string, operationId: string) {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('bind_launch_restitch', {
        p_team: teamId,
        p_generation: generationId,
        p_operation: operationId
      })
    );
    throwRpc(error);
  },
  async settleRestitch(teamId: string, generationId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('settle_launch_restitch', {
        p_team: teamId,
        p_generation: generationId
      })
    );
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },
  async retryRestitch(teamId: string, generationId: string, key: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('retry_launch_restitch', {
        p_team: teamId,
        p_generation: generationId,
        p_key: key
      })
    );
    throwRpc(error);
    if (
      !isRecord(data) ||
      data.generationId !== generationId ||
      typeof data.processKey !== 'string'
    )
      throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },
  async accounts(teamId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_accounts', { p_team: teamId })
    );
    throwRpc(error);
    if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data.map(row => {
      const account = parseTeamAccount(row);
      if (!account) throw new TeamApiError('INVALID_RESPONSE', false);
      return account;
    });
  },
  async selection(teamId: string, draft: LaunchDraft) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('resolve_launch_selection', {
        p_team: teamId,
        p_config: wire({
          agentRowId: draft.agentRowId,
          offerId: draft.offerId,
          buyerId: draft.buyerId,
          materialId: draft.materialId,
          method: draft.method,
          catalog: { restitchEnabled: draft.catalog?.restitchEnabled ?? false }
        })
      })
    );
    throwRpc(error);
    const source = parseLaunchSources(data);
    if (!source) throw new TeamApiError('INVALID_RESPONSE', false);
    return source;
  },
  async refreshSources(teamId: string, draft: LaunchDraft) {
    const value = await invokeTeamFunction(
      'drive-ops/launches/sources/refresh',
      {
        teamId,
        config: wire({
          agentRowId: draft.agentRowId,
          offerId: draft.offerId,
          buyerId: draft.buyerId,
          materialId: draft.materialId,
          method: draft.method,
          catalog: { restitchEnabled: draft.catalog?.restitchEnabled ?? false }
        })
      },
      (v: unknown): v is LaunchSourceSnapshot => parseLaunchSources(v) !== null
    );
    const source = parseLaunchSources(value);
    if (!source) throw new TeamApiError('INVALID_RESPONSE', false);
    return source;
  },
  async list(
    teamId: string,
    filter: Record<string, Json> = {},
    limit = 50
  ): Promise<{ items: LaunchSummary[]; nextCursor: { id: string; date: string | null } | null }> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_launches', {
        p_team: teamId,
        p_filter: filter,
        p_limit: limit
      })
    );
    throwRpc(error);
    if (!isRecord(data) || !Array.isArray(data.items))
      throw new TeamApiError('INVALID_RESPONSE', false);
    const items = data.items.map(parseLaunchSummary);
    if (items.some(x => !x)) throw new TeamApiError('INVALID_RESPONSE', false);
    let nextCursor: { id: string; date: string | null } | null = null;
    if (data.nextCursor !== null) {
      const c = data.nextCursor;
      if (
        !isRecord(c) ||
        typeof c.id !== 'string' ||
        (c.date !== null && typeof c.date !== 'string')
      )
        throw new TeamApiError('INVALID_RESPONSE', false);
      nextCursor = { id: c.id, date: c.date };
    }
    return { items: items.filter((x): x is LaunchSummary => x !== null), nextCursor };
  },
  async detail(
    teamId: string,
    id: string,
    revisionId: string | null = null,
    signal?: AbortSignal
  ): Promise<LaunchDetail> {
    const { data, error } = await withFreshSession(() => {
      const query = requireSupabaseClient().rpc('get_launch', {
        p_team: teamId,
        p_launch: id,
        p_revision: revisionId
      });
      return signal ? query.abortSignal(signal) : query;
    });
    throwRpc(error);
    const parsed = parseLaunchDetail(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },
  async save(input: {
    teamId: string;
    id: string | null;
    version: string | null;
    requestKey: string;
    config: LaunchDraft;
    sources: LaunchSourceSnapshot | null;
  }) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('save_launch_draft', {
        p_team: input.teamId,
        p_launch: input.id,
        p_expected_version: input.version,
        p_request_key: input.requestKey,
        p_config: wire(input.config),
        p_expected_sources: input.sources === null ? null : wire(input.sources)
      })
    );
    throwRpc(error);
    return mutation(data);
  },
  async sources(teamId: string, id: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_launch_sources', { p_team: teamId, p_launch: id })
    );
    throwRpc(error);
    const source = parseLaunchSources(data);
    if (!source) throw new TeamApiError('INVALID_RESPONSE', false);
    return source;
  },
  async dictionaries(teamId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_launch_dictionaries', { p_team: teamId })
    );
    throwRpc(error);
    if (!isRecord(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return { offers: dictionary(data.offers), buyers: dictionary(data.buyers) };
  },
  async editDictionary(
    teamId: string,
    kind: 'offers' | 'buyers',
    row: LaunchDictionaryItem,
    operation: 'rename' | 'archive' | 'restore',
    value: string,
    key: string
  ) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('edit_launch_dictionary', {
        p_team: teamId,
        p_kind: kind,
        p_id: row.id,
        p_expected_updated_at: row.updatedAt,
        p_operation: operation,
        p_value: value,
        p_request_key: key
      })
    );
    throwRpc(error);
    const result = dictionary([data])[0];
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },
  async createDictionary(teamId: string, kind: 'offers' | 'buyers', value: string, key: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('create_launch_dictionary', {
        p_team: teamId,
        p_kind: kind,
        p_value: value,
        p_request_key: key
      })
    );
    throwRpc(error);
    return dictionary([data])[0];
  },
  async defaults(teamId: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_launch_defaults', { p_team: teamId })
    );
    throwRpc(error);
    if (data === null) return null;
    if (!isRecord(data) || typeof data.version !== 'string')
      throw new TeamApiError('INVALID_RESPONSE', false);
    const config = parseLaunchDraft(data.config);
    const subConfig = parseLaunchSubConfig(data.subConfig);
    if (!config || !subConfig) throw new TeamApiError('INVALID_RESPONSE', false);
    return { config, subConfig, version: data.version };
  },
  async setDefaults(teamId: string, version: string | null, key: string, config: LaunchDraft) {
    const allowed = {
      buyerId: config.buyerId,
      campaignCount: config.campaignCount,
      maxBudget: config.maxBudget,
      minBudget: config.minBudget,
      adsCount: config.adsCount,
      age: config.age,
      gender: config.gender,
      method: config.method,
      advantagePlus: config.advantagePlus,
      catalog: config.catalog
    };
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_launch_defaults', {
        p_team: teamId,
        p_expected_version: version,
        p_key: key,
        p_config: wire(allowed),
        p_sub_config: wire(config.subConfig)
      })
    );
    throwRpc(error);
    return data;
  },
  async cancelRequest(teamId: string, id: string, requestKey: string, cancelKey: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('cancel_launch_request', {
        p_team: teamId,
        p_launch: id,
        p_key: requestKey,
        p_cancel_key: cancelKey
      })
    );
    throwRpc(error);
    if (!isRecord(data) || typeof data.state !== 'string')
      throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },
  async generate(teamId: string, id: string, version: string, key: string) {
    return invokeTeamFunction(
      'drive-ops/launches/generate',
      { teamId, launchId: id, expectedVersion: version, requestKey: key },
      (v: unknown): v is { id: string; state: string } =>
        isRecord(v) && typeof v.id === 'string' && typeof v.state === 'string'
    );
  },
  async cancel(teamId: string, id: string, generationId: string, key: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('cancel_launch_generation', {
        p_team: teamId,
        p_launch: id,
        p_generation: generationId,
        p_request_key: key
      })
    );
    throwRpc(error);
    return data;
  },
  async overrides(
    teamId: string,
    id: string,
    baselineId: string,
    version: string,
    key: string,
    overrides: LaunchOverrides
  ) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('save_launch_overrides', {
        p_team: teamId,
        p_launch: id,
        p_baseline: baselineId,
        p_expected_version: version,
        p_request_key: key,
        p_overrides: wire(overrides)
      })
    );
    throwRpc(error);
    return mutation(data);
  },
  async history(teamId: string, id: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_launch_revisions', { p_team: teamId, p_launch: id })
    );
    throwRpc(error);
    if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data.map(r => {
      if (
        !isRecord(r) ||
        typeof r.id !== 'string' ||
        typeof r.revisionNo !== 'number' ||
        !Number.isSafeInteger(r.revisionNo) ||
        r.revisionNo < 1 ||
        typeof r.createdAt !== 'string' ||
        !Number.isFinite(new Date(r.createdAt).getTime()) ||
        (r.kind !== 'manual' && r.kind !== 'generated')
      )
        throw new TeamApiError('INVALID_RESPONSE', false);
      const state =
        r.state === null ? null : LAUNCH_GENERATION_STATES.find(state => state === r.state);
      if (state === undefined) throw new TeamApiError('INVALID_RESPONSE', false);
      return { id: r.id, revisionNo: r.revisionNo, createdAt: r.createdAt, kind: r.kind, state };
    });
  },
  async saveWorkingCopy(input: {
    teamId: string;
    id: string;
    version: string;
    requestKey: string;
    config: LaunchDraft | null;
    sources: LaunchSourceSnapshot | null;
    baselineId: string | null;
    overrides: LaunchOverrides | null;
  }) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('save_launch_working_copy', {
        p_team: input.teamId,
        p_launch: input.id,
        p_expected_version: input.version,
        p_request_key: input.requestKey,
        p_config: wire(input.config),
        p_expected_sources: wire(input.sources),
        p_baseline: input.baselineId,
        p_overrides: wire(input.overrides)
      })
    );
    throwRpc(error);
    return mutation(data);
  },
  async metadata(
    teamId: string,
    id: string,
    version: string,
    key: string,
    status: 'todo' | 'in_progress' | 'done',
    assigneeId: string | null
  ) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('update_launch_metadata', {
        p_team: teamId,
        p_launch: id,
        p_expected_version: version,
        p_request_key: key,
        p_status: status,
        p_assignee: assigneeId
      })
    );
    throwRpc(error);
    return mutation(data);
  },
  async copy(
    teamId: string,
    id: string,
    version: string,
    key: string,
    timezone: string,
    revisionId: string | null = null
  ) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('copy_launch', {
        p_team: teamId,
        p_source: id,
        p_revision: revisionId,
        p_expected_version: version,
        p_key: key,
        p_timezone: timezone
      })
    );
    throwRpc(error);
    const copied = mutation(data);
    return copied;
  },
  async archiveWarning(teamId: string, id: string) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_launch_archive_warning', { p_team: teamId, p_launch: id })
    );
    throwRpc(error);
    if (
      !isRecord(data) ||
      typeof data.hasCatalog !== 'boolean' ||
      typeof data.hasRestitch !== 'boolean' ||
      typeof data.suppressed !== 'boolean'
    )
      throw new TeamApiError('INVALID_RESPONSE', false);
    return {
      hasCatalog: data.hasCatalog,
      hasRestitch: data.hasRestitch,
      suppressed: data.suppressed
    };
  },
  async archive(teamId: string, id: string, version: string, key: string, suppress: boolean) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('archive_launch', {
        p_team: teamId,
        p_launch: id,
        p_expected_version: version,
        p_key: key,
        p_suppress: suppress
      })
    );
    throwRpc(error);
    return mutation(data);
  }
};
