import type { GeneratedDatabase } from './database.types';

// PostgreSQL does not expose argument nullability to pg-meta. These nullable
// inputs are intentional clearing operations, not schema-generator guesses.
type NullableInputs = {
  set_team_agent_finance_value: 'p_value';
  set_team_catalog_update_interval: 'p_interval';
  set_team_material_tag: 'p_color';
  set_team_account_two_factor_seed: 'p_secret';
  set_team_agent_run_marker: 'p_marker';
  set_team_agent_money: 'p_balance' | 'p_topup';
  update_two_factor_entry: 'p_secret';
};
type Functions = GeneratedDatabase['public']['Functions'];
type AppFunctions = {
  [Name in keyof Functions]: Omit<Functions[Name], 'Args'> & {
    Args: {
      [Arg in keyof Functions[Name]['Args']]:
        | Functions[Name]['Args'][Arg]
        | (Name extends keyof NullableInputs
            ? Arg extends NullableInputs[Name]
              ? null
              : never
            : never);
    };
  };
};
export type Database = Omit<GeneratedDatabase, 'public'> & {
  public: Omit<GeneratedDatabase['public'], 'Functions' | 'Tables'> & {
    Functions: AppFunctions;
    Tables: Omit<GeneratedDatabase['public']['Tables'], 'profiles'> & {
      profiles: Omit<GeneratedDatabase['public']['Tables']['profiles'], 'Row'> & { Row: Profile };
    };
  };
};
export type SupportGoalStatus = 'draft' | 'active' | 'archived';
export type SupportGoalRow = Omit<
  Database['public']['Tables']['support_goals']['Row'],
  'status'
> & { status: SupportGoalStatus };
export type Profile = Omit<
  GeneratedDatabase['public']['Tables']['profiles']['Row'],
  'language' | 'plan' | 'account_status' | 'task_progress_max_default' | 'transcript_delete_pref'
> & {
  language: 'en' | 'uk';
  plan: 'free' | 'pro' | 'team';
  account_status: 'active' | 'blocked' | 'deleted';
} & Partial<
    Pick<
      GeneratedDatabase['public']['Tables']['profiles']['Row'],
      'task_progress_max_default' | 'transcript_delete_pref'
    >
  >;
export type AnalyticsEventRow = Database['public']['Tables']['analytics_events']['Row'];
export type AdminUserRow = Database['public']['Functions']['admin_list_users']['Returns'][number];
export type MarketingExportRow =
  Database['public']['Functions']['admin_marketing_export']['Returns'][number];
