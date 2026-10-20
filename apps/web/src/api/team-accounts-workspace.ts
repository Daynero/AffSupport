import {
  parseTeamAccountsOverview,
  parseTeamAccountOrderResult,
  parseTeamAccountArchivePreflight,
  parseTeamAccountLifecycleResult,
  parseTeamAccountNameColorResult,
  TEAM_ERROR_CODES,
  financeRecord,
  type TeamAccountEntityKind,
  type TeamAccountOrderScope,
  type TeamAccountNameColor
} from '@video-compressor/shared';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase';
import { TeamApiError } from './team';
import type { Database } from '../lib/database.types';

type WorkspaceFunction =
  | 'list_team_account_two_factor_seeds'
  | 'get_team_accounts_overview'
  | 'reorder_team_accounts'
  | 'get_team_account_archive_preflight'
  | 'set_team_account_archived'
  | 'set_team_account_name_color'
  | 'list_team_account_archive';
async function rpc(
  name: WorkspaceFunction,
  args: Database['public']['Functions'][WorkspaceFunction]['Args']
): Promise<unknown> {
  const { data, error } = await withFreshSession(() => requireSupabaseClient().rpc(name, args));
  if (error)
    throw new TeamApiError(
      TEAM_ERROR_CODES.find(code => error.message.includes(code)) ?? 'INVALID_RESPONSE',
      false
    );
  return data;
}
function parsed<T>(value: T | null): T {
  if (!value) throw new TeamApiError('INVALID_RESPONSE', false);
  return value;
}
export interface ArchivedAccountItem {
  id: string;
  entityKind: TeamAccountEntityKind;
  name: string;
  archivedAt: string | null;
  parentArchived: boolean;
  canRestore: boolean;
}
export const accountsWorkspaceApi = {
  async listArchive(teamId: string, query: string, cursor: string | null = null) {
    const value = await rpc('list_team_account_archive', {
      p_team: teamId,
      p_query: query,
      p_cursor: cursor,
      p_limit: 100
    });
    if (
      !financeRecord(value) ||
      !Array.isArray(value.items) ||
      !(value.next === null || typeof value.next === 'string')
    )
      throw new TeamApiError('INVALID_RESPONSE', false);
    const items: ArchivedAccountItem[] = [];
    for (const row of value.items) {
      if (
        !financeRecord(row) ||
        typeof row.id !== 'string' ||
        !['social', 'agent'].includes(String(row.entityKind)) ||
        typeof row.name !== 'string' ||
        !(row.archivedAt === null || typeof row.archivedAt === 'string') ||
        typeof row.parentArchived !== 'boolean' ||
        typeof row.canRestore !== 'boolean'
      )
        throw new TeamApiError('INVALID_RESPONSE', false);
      items.push({
        id: row.id,
        entityKind: row.entityKind === 'social' ? 'social' : 'agent',
        name: row.name,
        archivedAt: row.archivedAt,
        parentArchived: row.parentArchived,
        canRestore: row.canRestore
      });
    }
    return { items, next: value.next };
  },
  async overview(teamId: string, from: string, to: string, timezone: string) {
    const result = parsed(
      parseTeamAccountsOverview(
        await rpc('get_team_accounts_overview', {
          p_team: teamId,
          p_from: from,
          p_to: to,
          p_timezone: timezone
        })
      )
    );
    const seedRows = await rpc('list_team_account_two_factor_seeds', { p_team: teamId });
    if (!Array.isArray(seedRows)) throw new TeamApiError('INVALID_RESPONSE', false);
    const seeds = new Map<string, string>();
    for (const row of seedRows) {
      if (
        !financeRecord(row) ||
        typeof row.account_id !== 'string' ||
        typeof row.secret !== 'string'
      )
        throw new TeamApiError('INVALID_RESPONSE', false);
      seeds.set(row.account_id, row.secret);
    }
    return {
      ...result,
      accounts: result.accounts.map(account => ({
        ...account,
        twoFactorSeed: seeds.get(account.id) ?? null
      }))
    };
  },
  async reorder(
    teamId: string,
    scope: TeamAccountOrderScope,
    parent: string | null,
    moved: string,
    anchor: string,
    relation: 'before' | 'after',
    version: string,
    requestId: string
  ) {
    return parsed(
      parseTeamAccountOrderResult(
        await rpc('reorder_team_accounts', {
          p_team: teamId,
          p_scope: scope,
          p_parent: parent,
          p_moved: moved,
          p_anchor: anchor,
          p_relation: relation,
          p_expected_version: version,
          p_request_id: requestId
        })
      )
    );
  },
  async preflight(teamId: string, kind: TeamAccountEntityKind, id: string) {
    return parsed(
      parseTeamAccountArchivePreflight(
        await rpc('get_team_account_archive_preflight', {
          p_team: teamId,
          p_kind: kind,
          p_entity: id
        })
      )
    );
  },
  async archive(
    teamId: string,
    kind: TeamAccountEntityKind,
    id: string,
    archived: boolean,
    version: string,
    token: string,
    requestId: string
  ) {
    return parsed(
      parseTeamAccountLifecycleResult(
        await rpc('set_team_account_archived', {
          p_team: teamId,
          p_kind: kind,
          p_entity: id,
          p_archived: archived,
          p_expected_version: version,
          p_preflight_token: token,
          p_request_id: requestId
        })
      )
    );
  },
  async color(
    teamId: string,
    id: string,
    color: TeamAccountNameColor,
    version: string,
    requestId: string
  ) {
    return parsed(
      parseTeamAccountNameColorResult(
        await rpc('set_team_account_name_color', {
          p_team: teamId,
          p_agent: id,
          p_color: color,
          p_expected_version: version,
          p_request_id: requestId
        })
      )
    );
  }
};
