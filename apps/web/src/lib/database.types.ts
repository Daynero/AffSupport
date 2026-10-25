import type { Database } from './database.compat';
export type {
  Database,
  SupportGoalStatus,
  SupportGoalRow,
  Profile,
  AnalyticsEventRow,
  AdminUserRow,
  MarketingExportRow
} from './database.compat';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type GeneratedDatabase = {
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      agent_journal_records: {
        Row: {
          agent_instance_id: string;
          category: string;
          code: string;
          id: number;
          installation_id: string | null;
          props: NonNullable<Json>;
          received_at: string;
          recorded_at: string;
          seq: number;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          agent_instance_id: string;
          category: string;
          code: string;
          id?: never;
          installation_id?: string | null;
          props?: NonNullable<Json>;
          received_at?: string;
          recorded_at: string;
          seq: number;
          user_id?: string | null;
        };
        Update: {
          agent_instance_id?: string;
          category?: string;
          code?: string;
          id?: never;
          installation_id?: string | null;
          props?: NonNullable<Json>;
          received_at?: string;
          recorded_at?: string;
          seq?: number;
          user_id?: string | null;
        };
        Relationships: [];
      };
      analytics_daily_events: {
        Row: {
          count: number;
          day: string;
          event_name: string;
          users: number;
        };
        ComputedFields: never;
        Insert: {
          count?: number;
          day: string;
          event_name: string;
          users?: number;
        };
        Update: {
          count?: number;
          day?: string;
          event_name?: string;
          users?: number;
        };
        Relationships: [];
      };
      analytics_daily_tool_outcomes: {
        Row: {
          cancellations: number;
          completions: number;
          day: string;
          failures: number;
          local_app_version: string;
          platform: string;
          starts: number;
          tool: string;
          users: number;
        };
        ComputedFields: never;
        Insert: {
          cancellations?: number;
          completions?: number;
          day: string;
          failures?: number;
          local_app_version: string;
          platform: string;
          starts?: number;
          tool: string;
          users?: number;
        };
        Update: {
          cancellations?: number;
          completions?: number;
          day?: string;
          failures?: number;
          local_app_version?: string;
          platform?: string;
          starts?: number;
          tool?: string;
          users?: number;
        };
        Relationships: [];
      };
      analytics_events: {
        Row: {
          action: string | null;
          agent_instance_id: string | null;
          agent_platform: string | null;
          agent_version: string | null;
          app_version: string | null;
          architecture: string | null;
          attempt_id: string | null;
          core_api_version: number | null;
          created_at: string;
          error_code: string | null;
          error_fingerprint: string | null;
          error_stage: string | null;
          event_id: string;
          event_name: string;
          event_source: string | null;
          event_version: number;
          feature: string | null;
          flow_id: string | null;
          id: number;
          installation_id: string | null;
          local_app_build: string | null;
          local_app_version: string | null;
          locale: string | null;
          occurred_at: string;
          outcome: string | null;
          platform: string | null;
          properties: NonNullable<Json>;
          release_channel: string | null;
          run_id: string | null;
          screen: string | null;
          session_id: string | null;
          session_sequence: number | null;
          tool: string | null;
          tool_contracts: NonNullable<Json>;
          user_id: string | null;
          web_build_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          action?: string | null;
          agent_instance_id?: string | null;
          agent_platform?: string | null;
          agent_version?: string | null;
          app_version?: string | null;
          architecture?: string | null;
          attempt_id?: string | null;
          core_api_version?: number | null;
          created_at?: string;
          error_code?: string | null;
          error_fingerprint?: string | null;
          error_stage?: string | null;
          event_id?: string;
          event_name: string;
          event_source?: string | null;
          event_version?: number;
          feature?: string | null;
          flow_id?: string | null;
          id?: number;
          installation_id?: string | null;
          local_app_build?: string | null;
          local_app_version?: string | null;
          locale?: string | null;
          occurred_at?: string;
          outcome?: string | null;
          platform?: string | null;
          properties?: NonNullable<Json>;
          release_channel?: string | null;
          run_id?: string | null;
          screen?: string | null;
          session_id?: string | null;
          session_sequence?: number | null;
          tool?: string | null;
          tool_contracts?: NonNullable<Json>;
          user_id?: string | null;
          web_build_id?: string | null;
        };
        Update: {
          action?: string | null;
          agent_instance_id?: string | null;
          agent_platform?: string | null;
          agent_version?: string | null;
          app_version?: string | null;
          architecture?: string | null;
          attempt_id?: string | null;
          core_api_version?: number | null;
          created_at?: string;
          error_code?: string | null;
          error_fingerprint?: string | null;
          error_stage?: string | null;
          event_id?: string;
          event_name?: string;
          event_source?: string | null;
          event_version?: number;
          feature?: string | null;
          flow_id?: string | null;
          id?: number;
          installation_id?: string | null;
          local_app_build?: string | null;
          local_app_version?: string | null;
          locale?: string | null;
          occurred_at?: string;
          outcome?: string | null;
          platform?: string | null;
          properties?: NonNullable<Json>;
          release_channel?: string | null;
          run_id?: string | null;
          screen?: string | null;
          session_id?: string | null;
          session_sequence?: number | null;
          tool?: string | null;
          tool_contracts?: NonNullable<Json>;
          user_id?: string | null;
          web_build_id?: string | null;
        };
        Relationships: [];
      };
      geo_options: {
        Row: {
          code: string;
        };
        ComputedFields: never;
        Insert: {
          code: string;
        };
        Update: {
          code?: string;
        };
        Relationships: [];
      };
      language_options: {
        Row: {
          code: string;
        };
        ComputedFields: never;
        Insert: {
          code: string;
        };
        Update: {
          code?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          account_status: string;
          avatar_url: string | null;
          created_at: string;
          display_name: string | null;
          email: string | null;
          id: string;
          language: string;
          last_seen_at: string | null;
          marketing_consent: boolean;
          marketing_consent_at: string | null;
          onboarding_completed: boolean;
          plan: string;
          task_progress_max_default: number | null;
          transcript_delete_pref: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_status?: string;
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id: string;
          language?: string;
          last_seen_at?: string | null;
          marketing_consent?: boolean;
          marketing_consent_at?: string | null;
          onboarding_completed?: boolean;
          plan?: string;
          task_progress_max_default?: number | null;
          transcript_delete_pref?: string;
          updated_at?: string;
        };
        Update: {
          account_status?: string;
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          language?: string;
          last_seen_at?: string | null;
          marketing_consent?: boolean;
          marketing_consent_at?: string | null;
          onboarding_completed?: boolean;
          plan?: string;
          task_progress_max_default?: number | null;
          transcript_delete_pref?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      role_permissions: {
        Row: {
          allowed: boolean;
          permission: string;
          role: string;
        };
        ComputedFields: never;
        Insert: {
          allowed: boolean;
          permission: string;
          role: string;
        };
        Update: {
          allowed?: boolean;
          permission?: string;
          role?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'role_permissions_permission_fkey';
            columns: ['permission'];
            isOneToOne: false;
            referencedRelation: 'team_permissions';
            referencedColumns: ['permission'];
          },
          {
            foreignKeyName: 'role_permissions_role_fkey';
            columns: ['role'];
            isOneToOne: false;
            referencedRelation: 'team_roles';
            referencedColumns: ['role'];
          }
        ];
      };
      space_tariff_events: {
        Row: {
          actor_id: string | null;
          after: Json | null;
          before: Json | null;
          created_at: string;
          id: string;
          kind: string;
          tariff_id: string | null;
          team_id: string | null;
          toast_acked_at: string | null;
          undone_at: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          id?: string;
          kind: string;
          tariff_id?: string | null;
          team_id?: string | null;
          toast_acked_at?: string | null;
          undone_at?: string | null;
        };
        Update: {
          actor_id?: string | null;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          id?: string;
          kind?: string;
          tariff_id?: string | null;
          team_id?: string | null;
          toast_acked_at?: string | null;
          undone_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'space_tariff_events_tariff_id_fkey';
            columns: ['tariff_id'];
            isOneToOne: false;
            referencedRelation: 'space_tariffs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'space_tariff_events_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      space_tariff_notices: {
        Row: {
          attempts: number;
          created_at: string;
          id: string;
          kind: string;
          last_error: string | null;
          lease_until: string | null;
          period_end: string;
          requested_by: string | null;
          sent_at: string | null;
          state: string;
          tariff_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          created_at?: string;
          id?: string;
          kind: string;
          last_error?: string | null;
          lease_until?: string | null;
          period_end: string;
          requested_by?: string | null;
          sent_at?: string | null;
          state?: string;
          tariff_id: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          id?: string;
          kind?: string;
          last_error?: string | null;
          lease_until?: string | null;
          period_end?: string;
          requested_by?: string | null;
          sent_at?: string | null;
          state?: string;
          tariff_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'space_tariff_notices_requested_by_fkey';
            columns: ['requested_by'];
            isOneToOne: false;
            referencedRelation: 'analytics_users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'space_tariff_notices_requested_by_fkey';
            columns: ['requested_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'space_tariff_notices_tariff_id_fkey';
            columns: ['tariff_id'];
            isOneToOne: false;
            referencedRelation: 'space_tariffs';
            referencedColumns: ['id'];
          }
        ];
      };
      space_tariffs: {
        Row: {
          bound_at: string | null;
          claimed_at: string | null;
          created_at: string;
          ends_on: string;
          external_ref: string | null;
          extra_seats: number;
          granted_by: string | null;
          id: string;
          note: string | null;
          owner_email: string;
          owner_id: string | null;
          plan_code: string;
          revoked_at: string | null;
          source: string;
          starts_at: string;
          team_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          bound_at?: string | null;
          claimed_at?: string | null;
          created_at?: string;
          ends_on: string;
          external_ref?: string | null;
          extra_seats?: number;
          granted_by?: string | null;
          id?: string;
          note?: string | null;
          owner_email: string;
          owner_id?: string | null;
          plan_code: string;
          revoked_at?: string | null;
          source?: string;
          starts_at?: string;
          team_id?: string | null;
          updated_at?: string;
        };
        Update: {
          bound_at?: string | null;
          claimed_at?: string | null;
          created_at?: string;
          ends_on?: string;
          external_ref?: string | null;
          extra_seats?: number;
          granted_by?: string | null;
          id?: string;
          note?: string | null;
          owner_email?: string;
          owner_id?: string | null;
          plan_code?: string;
          revoked_at?: string | null;
          source?: string;
          starts_at?: string;
          team_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'space_tariffs_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'analytics_users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'space_tariffs_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'space_tariffs_plan_code_fkey';
            columns: ['plan_code'];
            isOneToOne: false;
            referencedRelation: 'tariff_plans';
            referencedColumns: ['code'];
          },
          {
            foreignKeyName: 'space_tariffs_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      support_goals: {
        Row: {
          created_at: string;
          currency: string;
          description_en: string;
          description_uk: string;
          id: string;
          raised_cents: number;
          slug: string;
          status: string;
          target_cents: number;
          title_en: string;
          title_uk: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          currency?: string;
          description_en: string;
          description_uk: string;
          id?: string;
          raised_cents?: number;
          slug: string;
          status?: string;
          target_cents: number;
          title_en: string;
          title_uk: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          currency?: string;
          description_en?: string;
          description_uk?: string;
          id?: string;
          raised_cents?: number;
          slug?: string;
          status?: string;
          target_cents?: number;
          title_en?: string;
          title_uk?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tariff_plans: {
        Row: {
          active: boolean;
          base_seats: number;
          billing_period: string | null;
          code: string;
          created_at: string;
          extra_seats_allowed: boolean;
          features: string[];
          highlight: boolean;
          invites_allowed: boolean;
          max_extra_seats: number | null;
          name_en: string;
          name_uk: string;
          showcase: boolean;
          sort_order: number;
          summary_en: string;
          summary_uk: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          base_seats: number;
          billing_period?: string | null;
          code: string;
          created_at?: string;
          extra_seats_allowed?: boolean;
          features?: string[];
          highlight?: boolean;
          invites_allowed?: boolean;
          max_extra_seats?: number | null;
          name_en: string;
          name_uk: string;
          showcase?: boolean;
          sort_order?: number;
          summary_en?: string;
          summary_uk?: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          base_seats?: number;
          billing_period?: string | null;
          code?: string;
          created_at?: string;
          extra_seats_allowed?: boolean;
          features?: string[];
          highlight?: boolean;
          invites_allowed?: boolean;
          max_extra_seats?: number | null;
          name_en?: string;
          name_uk?: string;
          showcase?: boolean;
          sort_order?: number;
          summary_en?: string;
          summary_uk?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tariff_settings: {
        Row: {
          admin_email: string | null;
          admin_telegram: string | null;
          id: boolean;
          legacy_rule_enabled: boolean;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          admin_email?: string | null;
          admin_telegram?: string | null;
          id?: boolean;
          legacy_rule_enabled?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          admin_email?: string | null;
          admin_telegram?: string | null;
          id?: boolean;
          legacy_rule_enabled?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      tariff_settings_events: {
        Row: {
          actor_id: string | null;
          after: Json | null;
          before: Json | null;
          created_at: string;
          id: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          id?: string;
        };
        Update: {
          actor_id?: string | null;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          id?: string;
        };
        Relationships: [];
      };
      team_account_agents: {
        Row: {
          account_id: string;
          agent_id: string;
          archived_at: string | null;
          balance: number | null;
          created_at: string;
          created_by: string;
          id: string;
          lifecycle_version: number;
          sort_rank: number;
          starts_on: string | null;
          team_id: string;
          topup: number | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          agent_id: string;
          archived_at?: string | null;
          balance?: number | null;
          created_at?: string;
          created_by: string;
          id?: string;
          lifecycle_version?: number;
          sort_rank?: number;
          starts_on?: string | null;
          team_id: string;
          topup?: number | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          agent_id?: string;
          archived_at?: string | null;
          balance?: number | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          lifecycle_version?: number;
          sort_rank?: number;
          starts_on?: string | null;
          team_id?: string;
          topup?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_account_agents_account_id_team_id_fkey';
            columns: ['account_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_accounts';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_account_agents_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_account_content_revisions: {
        Row: {
          entity_id: string;
          entity_kind: string;
          finance_revision: number;
          membership_revision: number;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          entity_id: string;
          entity_kind: string;
          finance_revision?: number;
          membership_revision?: number;
          team_id: string;
        };
        Update: {
          entity_id?: string;
          entity_kind?: string;
          finance_revision?: number;
          membership_revision?: number;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_account_content_revisions_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_account_lifecycle_events: {
        Row: {
          actor_id: string;
          archived: boolean;
          entity_id: string;
          entity_kind: string;
          id: string;
          occurred_at: string;
          request_id: string;
          team_id: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          archived: boolean;
          entity_id: string;
          entity_kind: string;
          id?: string;
          occurred_at?: string;
          request_id: string;
          team_id: string;
          version: number;
        };
        Update: {
          actor_id?: string;
          archived?: boolean;
          entity_id?: string;
          entity_kind?: string;
          id?: string;
          occurred_at?: string;
          request_id?: string;
          team_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_account_lifecycle_events_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_account_mutation_receipts: {
        Row: {
          actor_id: string;
          operation_id: string;
          payload: NonNullable<Json>;
          request_id: string;
          result: NonNullable<Json>;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          operation_id?: string;
          payload: NonNullable<Json>;
          request_id: string;
          result: NonNullable<Json>;
          team_id: string;
        };
        Update: {
          actor_id?: string;
          operation_id?: string;
          payload?: NonNullable<Json>;
          request_id?: string;
          result?: NonNullable<Json>;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_account_mutation_receipts_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_account_order_scopes: {
        Row: {
          parent_id: string;
          scope: string;
          team_id: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          parent_id: string;
          scope: string;
          team_id: string;
          version?: number;
        };
        Update: {
          parent_id?: string;
          scope?: string;
          team_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_account_order_scopes_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_account_parent_history: {
        Row: {
          account_id: string;
          agent_row_id: string;
          ends_at: string | null;
          id: string;
          provenance: string;
          starts_at: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          agent_row_id: string;
          ends_at?: string | null;
          id?: string;
          provenance: string;
          starts_at: string;
          team_id: string;
        };
        Update: {
          account_id?: string;
          agent_row_id?: string;
          ends_at?: string | null;
          id?: string;
          provenance?: string;
          starts_at?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_account_parent_history_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_account_preferences: {
        Row: {
          agent_id: string;
          name_color: number;
          team_id: string;
          user_id: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          agent_id: string;
          name_color?: number;
          team_id: string;
          user_id: string;
          version?: number;
        };
        Update: {
          agent_id?: string;
          name_color?: number;
          team_id?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_account_preferences_agent_id_fkey';
            columns: ['agent_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_account_preferences_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_account_workspace_signals: {
        Row: {
          change_kind: string;
          revision: number;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          change_kind?: string;
          revision?: number;
          team_id: string;
        };
        Update: {
          change_kind?: string;
          revision?: number;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_account_workspace_signals_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: true;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_accounts: {
        Row: {
          archived_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          lifecycle_version: number;
          name: string;
          sort_rank: number;
          starts_on: string | null;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          created_by: string;
          id?: string;
          lifecycle_version?: number;
          name: string;
          sort_rank?: number;
          starts_on?: string | null;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          lifecycle_version?: number;
          name?: string;
          sort_rank?: number;
          starts_on?: string | null;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_accounts_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_agent_finance_events: {
        Row: {
          account_id: string;
          actor_id: string | null;
          agent_row_id: string;
          entry_date: string;
          id: string;
          metric: string;
          new_cents: number | null;
          new_version: number;
          occurred_at: string;
          old_cents: number | null;
          placement_id: string;
          previous_version: number;
          request_id: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          actor_id?: string | null;
          agent_row_id: string;
          entry_date: string;
          id?: string;
          metric: string;
          new_cents?: number | null;
          new_version: number;
          occurred_at?: string;
          old_cents?: number | null;
          placement_id: string;
          previous_version: number;
          request_id: string;
          team_id: string;
        };
        Update: {
          account_id?: string;
          actor_id?: string | null;
          agent_row_id?: string;
          entry_date?: string;
          id?: string;
          metric?: string;
          new_cents?: number | null;
          new_version?: number;
          occurred_at?: string;
          old_cents?: number | null;
          placement_id?: string;
          previous_version?: number;
          request_id?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_agent_finance_events_account_id_team_id_fkey';
            columns: ['account_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_accounts';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_finance_events_agent_row_id_team_id_fkey';
            columns: ['agent_row_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_finance_events_placement_id_team_id_agent_row_i_fkey';
            columns: ['placement_id', 'team_id', 'agent_row_id', 'account_id'];
            isOneToOne: false;
            referencedRelation: 'team_agent_placements';
            referencedColumns: ['id', 'team_id', 'agent_row_id', 'account_id'];
          },
          {
            foreignKeyName: 'team_agent_finance_events_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_agent_finance_legacy: {
        Row: {
          account_id: string;
          agent_row_id: string;
          balance_imported_event_id: string | null;
          balance_units: number | null;
          captured_at: string;
          id: string;
          requested_topup_units: number | null;
          team_id: string;
          topup_imported_event_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          agent_row_id: string;
          balance_imported_event_id?: string | null;
          balance_units?: number | null;
          captured_at?: string;
          id?: string;
          requested_topup_units?: number | null;
          team_id: string;
          topup_imported_event_id?: string | null;
        };
        Update: {
          account_id?: string;
          agent_row_id?: string;
          balance_imported_event_id?: string | null;
          balance_units?: number | null;
          captured_at?: string;
          id?: string;
          requested_topup_units?: number | null;
          team_id?: string;
          topup_imported_event_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_agent_finance_legacy_account_id_team_id_fkey';
            columns: ['account_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_accounts';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_finance_legacy_agent_row_id_team_id_fkey';
            columns: ['agent_row_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_finance_legacy_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_agent_finance_requests: {
        Row: {
          actor_id: string;
          created_at: string;
          payload: NonNullable<Json>;
          request_id: string;
          result: NonNullable<Json>;
          team_id: string;
          undone_by_request_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          created_at?: string;
          payload: NonNullable<Json>;
          request_id: string;
          result: NonNullable<Json>;
          team_id: string;
          undone_by_request_id?: string | null;
        };
        Update: {
          actor_id?: string;
          created_at?: string;
          payload?: NonNullable<Json>;
          request_id?: string;
          result?: NonNullable<Json>;
          team_id?: string;
          undone_by_request_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_agent_finance_requests_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_agent_finance_values: {
        Row: {
          account_id: string;
          agent_row_id: string;
          amount_cents: number | null;
          currency: string;
          entry_date: string;
          id: string;
          metric: string;
          placement_id: string;
          team_id: string;
          updated_at: string;
          updated_by: string | null;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          agent_row_id: string;
          amount_cents?: number | null;
          currency?: string;
          entry_date: string;
          id?: string;
          metric: string;
          placement_id: string;
          team_id: string;
          updated_at?: string;
          updated_by?: string | null;
          version?: number;
        };
        Update: {
          account_id?: string;
          agent_row_id?: string;
          amount_cents?: number | null;
          currency?: string;
          entry_date?: string;
          id?: string;
          metric?: string;
          placement_id?: string;
          team_id?: string;
          updated_at?: string;
          updated_by?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_agent_finance_values_account_id_team_id_fkey';
            columns: ['account_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_accounts';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_finance_values_agent_row_id_team_id_fkey';
            columns: ['agent_row_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_finance_values_placement_id_team_id_agent_row_i_fkey';
            columns: ['placement_id', 'team_id', 'agent_row_id', 'account_id'];
            isOneToOne: false;
            referencedRelation: 'team_agent_placements';
            referencedColumns: ['id', 'team_id', 'agent_row_id', 'account_id'];
          },
          {
            foreignKeyName: 'team_agent_finance_values_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_agent_labels: {
        Row: {
          agent_row_id: string;
          attached_at: string;
          attached_by: string;
          id: string;
          label_id: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          agent_row_id: string;
          attached_at?: string;
          attached_by: string;
          id?: string;
          label_id: string;
          team_id: string;
        };
        Update: {
          agent_row_id?: string;
          attached_at?: string;
          attached_by?: string;
          id?: string;
          label_id?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_agent_labels_agent_row_id_team_id_fkey';
            columns: ['agent_row_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_labels_label_id_team_id_fkey';
            columns: ['label_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_labels';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_labels_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_agent_placements: {
        Row: {
          account_id: string;
          agent_row_id: string;
          ends_on: string | null;
          id: string;
          starts_on: string;
          team_id: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          agent_row_id: string;
          ends_on?: string | null;
          id?: string;
          starts_on: string;
          team_id: string;
          version?: number;
        };
        Update: {
          account_id?: string;
          agent_row_id?: string;
          ends_on?: string | null;
          id?: string;
          starts_on?: string;
          team_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_agent_placements_account_id_team_id_fkey';
            columns: ['account_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_accounts';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_placements_agent_row_id_team_id_fkey';
            columns: ['agent_row_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_placements_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_agent_runs: {
        Row: {
          agent_row_id: string;
          created_at: string;
          created_by: string;
          id: string;
          marker: string | null;
          note: string;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          agent_row_id: string;
          created_at?: string;
          created_by: string;
          id?: string;
          marker?: string | null;
          note: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          agent_row_id?: string;
          created_at?: string;
          created_by?: string;
          id?: string;
          marker?: string | null;
          note?: string;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_agent_runs_agent_row_id_team_id_fkey';
            columns: ['agent_row_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_runs_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_agent_transfer_events: {
        Row: {
          actor_id: string | null;
          agent_row_id: string;
          effective_on: string;
          from_account_id: string | null;
          from_account_name: string | null;
          from_placement_id: string | null;
          id: string;
          occurred_at: string;
          request_id: string;
          team_id: string;
          to_account_id: string | null;
          to_account_name: string | null;
          to_placement_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          agent_row_id: string;
          effective_on: string;
          from_account_id?: string | null;
          from_account_name?: string | null;
          from_placement_id?: string | null;
          id?: string;
          occurred_at?: string;
          request_id: string;
          team_id: string;
          to_account_id?: string | null;
          to_account_name?: string | null;
          to_placement_id?: string | null;
        };
        Update: {
          actor_id?: string | null;
          agent_row_id?: string;
          effective_on?: string;
          from_account_id?: string | null;
          from_account_name?: string | null;
          from_placement_id?: string | null;
          id?: string;
          occurred_at?: string;
          request_id?: string;
          team_id?: string;
          to_account_id?: string | null;
          to_account_name?: string | null;
          to_placement_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_agent_transfer_events_agent_row_id_team_id_fkey';
            columns: ['agent_row_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_transfer_events_from_placement_id_team_id_fkey';
            columns: ['from_placement_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_agent_placements';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_agent_transfer_events_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_agent_transfer_events_to_placement_id_team_id_fkey';
            columns: ['to_placement_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_agent_placements';
            referencedColumns: ['id', 'team_id'];
          }
        ];
      };
      team_audit_events: {
        Row: {
          action: string;
          actor_id: string | null;
          actor_label_snapshot: string | null;
          error_code: string | null;
          id: string;
          occurred_at: string;
          result: string;
          target: NonNullable<Json>;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_id?: string | null;
          actor_label_snapshot?: string | null;
          error_code?: string | null;
          id?: string;
          occurred_at?: string;
          result: string;
          target?: NonNullable<Json>;
          team_id: string;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          actor_label_snapshot?: string | null;
          error_code?: string | null;
          id?: string;
          occurred_at?: string;
          result?: string;
          target?: NonNullable<Json>;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_audit_events_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_catalog_events: {
        Row: {
          event_kind: string;
          id: number;
          material_id: string | null;
          occurred_at: string;
          parent_folder_id: string | null;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          event_kind: string;
          id?: number;
          material_id?: string | null;
          occurred_at?: string;
          parent_folder_id?: string | null;
          team_id: string;
        };
        Update: {
          event_kind?: string;
          id?: number;
          material_id?: string | null;
          occurred_at?: string;
          parent_folder_id?: string | null;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_catalog_events_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_catalog_restitch_copies: {
        Row: {
          catalog_material_id: string | null;
          created_at: string;
          delete_attempts: number;
          drive_file_id: string;
          material_id: string;
          next_delete_at: string | null;
          operation_id: string | null;
          retired_at: string | null;
          role: string;
          shared_link: string | null;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          catalog_material_id?: string | null;
          created_at?: string;
          delete_attempts?: number;
          drive_file_id: string;
          material_id: string;
          next_delete_at?: string | null;
          operation_id?: string | null;
          retired_at?: string | null;
          role: string;
          shared_link?: string | null;
          team_id: string;
        };
        Update: {
          catalog_material_id?: string | null;
          created_at?: string;
          delete_attempts?: number;
          drive_file_id?: string;
          material_id?: string;
          next_delete_at?: string | null;
          operation_id?: string | null;
          retired_at?: string | null;
          role?: string;
          shared_link?: string | null;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_catalog_restitch_copies_catalog_material_id_fkey';
            columns: ['catalog_material_id'];
            isOneToOne: false;
            referencedRelation: 'team_product_catalogs';
            referencedColumns: ['material_id'];
          },
          {
            foreignKeyName: 'team_catalog_restitch_copies_material_id_fkey';
            columns: ['material_id'];
            isOneToOne: true;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_catalog_restitch_copies_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_catalog_update_attempts: {
        Row: {
          actual_changes: Json | null;
          attempt_id: string;
          catalog_material_id: string;
          delivery_verified_at: string | null;
          ended_at: string | null;
          failure_code: string | null;
          profile_snapshot: Json | null;
          profile_version: number | null;
          requested_by: string | null;
          result: string;
          round_due_at: string;
          source_attempt_id: string | null;
          stage_history: NonNullable<Json>;
          started_at: string;
          team_id: string;
          trigger_kind: string;
        };
        ComputedFields: never;
        Insert: {
          actual_changes?: Json | null;
          attempt_id?: string;
          catalog_material_id: string;
          delivery_verified_at?: string | null;
          ended_at?: string | null;
          failure_code?: string | null;
          profile_snapshot?: Json | null;
          profile_version?: number | null;
          requested_by?: string | null;
          result?: string;
          round_due_at: string;
          source_attempt_id?: string | null;
          stage_history?: NonNullable<Json>;
          started_at?: string;
          team_id: string;
          trigger_kind: string;
        };
        Update: {
          actual_changes?: Json | null;
          attempt_id?: string;
          catalog_material_id?: string;
          delivery_verified_at?: string | null;
          ended_at?: string | null;
          failure_code?: string | null;
          profile_snapshot?: Json | null;
          profile_version?: number | null;
          requested_by?: string | null;
          result?: string;
          round_due_at?: string;
          source_attempt_id?: string | null;
          stage_history?: NonNullable<Json>;
          started_at?: string;
          team_id?: string;
          trigger_kind?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_catalog_update_attempts_catalog_material_id_fkey';
            columns: ['catalog_material_id'];
            isOneToOne: false;
            referencedRelation: 'team_product_catalogs';
            referencedColumns: ['material_id'];
          },
          {
            foreignKeyName: 'team_catalog_update_attempts_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_catalog_update_profiles: {
        Row: {
          catalog_material_id: string;
          grow_products: boolean;
          random_link_variation: boolean;
          refresh_images: boolean;
          refresh_texts: boolean;
          restitch: boolean;
          schedule: Json | null;
          team_id: string;
          updated_at: string;
          updated_by: string | null;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          catalog_material_id: string;
          grow_products: boolean;
          random_link_variation: boolean;
          refresh_images: boolean;
          refresh_texts: boolean;
          restitch: boolean;
          schedule?: Json | null;
          team_id: string;
          updated_at?: string;
          updated_by?: string | null;
          version?: number;
        };
        Update: {
          catalog_material_id?: string;
          grow_products?: boolean;
          random_link_variation?: boolean;
          refresh_images?: boolean;
          refresh_texts?: boolean;
          restitch?: boolean;
          schedule?: Json | null;
          team_id?: string;
          updated_at?: string;
          updated_by?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_catalog_update_profiles_catalog_material_id_fkey';
            columns: ['catalog_material_id'];
            isOneToOne: true;
            referencedRelation: 'team_product_catalogs';
            referencedColumns: ['material_id'];
          },
          {
            foreignKeyName: 'team_catalog_update_profiles_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_catalog_updater_items: {
        Row: {
          added_at: string;
          attempts: number;
          catalog_material_id: string;
          config_generation: number;
          lease_expires_at: string | null;
          lease_owner: string | null;
          next_attempt_at: string;
          next_run_at: string | null;
          paused_interval: string | null;
          reconciliation_required: boolean;
          round_due_at: string | null;
          tariff_pause_id: string | null;
          tariff_paused_round_at: string | null;
          team_id: string;
          update_interval: string | null;
        };
        ComputedFields: never;
        Insert: {
          added_at?: string;
          attempts?: number;
          catalog_material_id: string;
          config_generation?: number;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          next_attempt_at?: string;
          next_run_at?: string | null;
          paused_interval?: string | null;
          reconciliation_required?: boolean;
          round_due_at?: string | null;
          tariff_pause_id?: string | null;
          tariff_paused_round_at?: string | null;
          team_id: string;
          update_interval?: string | null;
        };
        Update: {
          added_at?: string;
          attempts?: number;
          catalog_material_id?: string;
          config_generation?: number;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          next_attempt_at?: string;
          next_run_at?: string | null;
          paused_interval?: string | null;
          reconciliation_required?: boolean;
          round_due_at?: string | null;
          tariff_pause_id?: string | null;
          tariff_paused_round_at?: string | null;
          team_id?: string;
          update_interval?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_catalog_updater_items_catalog_material_id_fkey';
            columns: ['catalog_material_id'];
            isOneToOne: true;
            referencedRelation: 'team_product_catalogs';
            referencedColumns: ['material_id'];
          },
          {
            foreignKeyName: 'team_catalog_updater_items_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'team_catalog_updaters';
            referencedColumns: ['team_id'];
          }
        ];
      };
      team_catalog_updaters: {
        Row: {
          default_restitch: boolean;
          grow_products: boolean;
          next_run_at: string | null;
          paused_by_tariff_at: string | null;
          random_link_variation: boolean | null;
          refresh_images: boolean;
          refresh_texts: boolean;
          restitch: boolean;
          started_at: string | null;
          started_by: string | null;
          state: string;
          team_id: string;
          update_interval: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          default_restitch?: boolean;
          grow_products?: boolean;
          next_run_at?: string | null;
          paused_by_tariff_at?: string | null;
          random_link_variation?: boolean | null;
          refresh_images?: boolean;
          refresh_texts?: boolean;
          restitch?: boolean;
          started_at?: string | null;
          started_by?: string | null;
          state?: string;
          team_id: string;
          update_interval?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          default_restitch?: boolean;
          grow_products?: boolean;
          next_run_at?: string | null;
          paused_by_tariff_at?: string | null;
          random_link_variation?: boolean | null;
          refresh_images?: boolean;
          refresh_texts?: boolean;
          restitch?: boolean;
          started_at?: string | null;
          started_by?: string | null;
          state?: string;
          team_id?: string;
          update_interval?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_catalog_updaters_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: true;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_contract_settings: {
        Row: {
          key: string;
          value: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          key: string;
          value: NonNullable<Json>;
        };
        Update: {
          key?: string;
          value?: NonNullable<Json>;
        };
        Relationships: [];
      };
      team_contribution_records: {
        Row: {
          action_kind: string;
          actor_id: string;
          agent_instance_id: string | null;
          category: string;
          id: string;
          occurred_at: string;
          outcome: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          action_kind: string;
          actor_id: string;
          agent_instance_id?: string | null;
          category: string;
          id?: string;
          occurred_at?: string;
          outcome: string;
          team_id: string;
        };
        Update: {
          action_kind?: string;
          actor_id?: string;
          agent_instance_id?: string | null;
          category?: string;
          id?: string;
          occurred_at?: string;
          outcome?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_contribution_records_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_drive_connections: {
        Row: {
          access_expires_at: string | null;
          capabilities_checked_at: string | null;
          capability_snapshot: NonNullable<Json>;
          change_page_token: string | null;
          connected_at: string | null;
          created_at: string;
          credential_id: string;
          detached_at: string | null;
          drive_id: string | null;
          drive_kind: string;
          id: string;
          initial_sync_state: string;
          last_error_code: string | null;
          last_reconciled_at: string | null;
          last_synced_at: string | null;
          root_folder_id: string;
          root_folder_name: string;
          root_resource_key: string | null;
          scope_set: string[];
          state: string;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          access_expires_at?: string | null;
          capabilities_checked_at?: string | null;
          capability_snapshot?: NonNullable<Json>;
          change_page_token?: string | null;
          connected_at?: string | null;
          created_at?: string;
          credential_id: string;
          detached_at?: string | null;
          drive_id?: string | null;
          drive_kind: string;
          id?: string;
          initial_sync_state?: string;
          last_error_code?: string | null;
          last_reconciled_at?: string | null;
          last_synced_at?: string | null;
          root_folder_id: string;
          root_folder_name: string;
          root_resource_key?: string | null;
          scope_set?: string[];
          state?: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          access_expires_at?: string | null;
          capabilities_checked_at?: string | null;
          capability_snapshot?: NonNullable<Json>;
          change_page_token?: string | null;
          connected_at?: string | null;
          created_at?: string;
          credential_id?: string;
          detached_at?: string | null;
          drive_id?: string | null;
          drive_kind?: string;
          id?: string;
          initial_sync_state?: string;
          last_error_code?: string | null;
          last_reconciled_at?: string | null;
          last_synced_at?: string | null;
          root_folder_id?: string;
          root_folder_name?: string;
          root_resource_key?: string | null;
          scope_set?: string[];
          state?: string;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_drive_connections_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_drive_selections: {
        Row: {
          connection_id: string;
          created_at: string;
          drive_folder_id: string;
          id: string;
          is_root: boolean;
          name: string;
          removed_at: string | null;
          resource_key: string | null;
          selected_at: string;
          selected_by: string | null;
          state: string;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          connection_id: string;
          created_at?: string;
          drive_folder_id: string;
          id?: string;
          is_root?: boolean;
          name: string;
          removed_at?: string | null;
          resource_key?: string | null;
          selected_at?: string;
          selected_by?: string | null;
          state?: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          connection_id?: string;
          created_at?: string;
          drive_folder_id?: string;
          id?: string;
          is_root?: boolean;
          name?: string;
          removed_at?: string | null;
          resource_key?: string | null;
          selected_at?: string;
          selected_by?: string | null;
          state?: string;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_drive_selections_connection_id_fkey';
            columns: ['connection_id'];
            isOneToOne: false;
            referencedRelation: 'team_drive_connections';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_drive_selections_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_error_codes: {
        Row: {
          code: string;
        };
        ComputedFields: never;
        Insert: {
          code: string;
        };
        Update: {
          code?: string;
        };
        Relationships: [];
      };
      team_invitations: {
        Row: {
          accept_token_hash: string;
          created_at: string;
          delivery_error_code: string | null;
          delivery_state: string;
          expires_at: string;
          id: string;
          initial_role: string;
          inviter_id: string;
          last_sent_at: string;
          responded_at: string | null;
          state: string;
          target_email: string;
          target_user_id: string | null;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          accept_token_hash: string;
          created_at?: string;
          delivery_error_code?: string | null;
          delivery_state?: string;
          expires_at: string;
          id?: string;
          initial_role: string;
          inviter_id: string;
          last_sent_at?: string;
          responded_at?: string | null;
          state?: string;
          target_email: string;
          target_user_id?: string | null;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          accept_token_hash?: string;
          created_at?: string;
          delivery_error_code?: string | null;
          delivery_state?: string;
          expires_at?: string;
          id?: string;
          initial_role?: string;
          inviter_id?: string;
          last_sent_at?: string;
          responded_at?: string | null;
          state?: string;
          target_email?: string;
          target_user_id?: string | null;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_invitations_initial_role_fkey';
            columns: ['initial_role'];
            isOneToOne: false;
            referencedRelation: 'team_roles';
            referencedColumns: ['role'];
          },
          {
            foreignKeyName: 'team_invitations_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_labels: {
        Row: {
          color: string;
          created_at: string;
          created_by: string;
          id: string;
          name: string;
          scope: string;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          color?: string;
          created_at?: string;
          created_by: string;
          id?: string;
          name: string;
          scope?: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          color?: string;
          created_at?: string;
          created_by?: string;
          id?: string;
          name?: string;
          scope?: string;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_task_labels_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_landing_renders: {
        Row: {
          artifact_root: string | null;
          created_at: string;
          failure_reason: string | null;
          fingerprint: string | null;
          id: string;
          material_id: string;
          preset: string;
          render_state: string;
          rendered_by: string | null;
          segment_count: number;
          source_checksum: string | null;
          source_version: string | null;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          artifact_root?: string | null;
          created_at?: string;
          failure_reason?: string | null;
          fingerprint?: string | null;
          id?: string;
          material_id: string;
          preset?: string;
          render_state?: string;
          rendered_by?: string | null;
          segment_count?: number;
          source_checksum?: string | null;
          source_version?: string | null;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          artifact_root?: string | null;
          created_at?: string;
          failure_reason?: string | null;
          fingerprint?: string | null;
          id?: string;
          material_id?: string;
          preset?: string;
          render_state?: string;
          rendered_by?: string | null;
          segment_count?: number;
          source_checksum?: string | null;
          source_version?: string | null;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_landing_renders_material_fk';
            columns: ['material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_landing_renders_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launch_buyers: {
        Row: {
          archived_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          normalized_key: string;
          team_id: string;
          updated_at: string;
          value: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          created_by: string;
          id?: string;
          normalized_key: string;
          team_id: string;
          updated_at?: string;
          value: string;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          normalized_key?: string;
          team_id?: string;
          updated_at?: string;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_buyers_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launch_campaigns: {
        Row: {
          ad_end: number;
          ad_start: number;
          budget_usd: number;
          name: string;
          ordinal: number;
          revision_id: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          ad_end: number;
          ad_start: number;
          budget_usd: number;
          name: string;
          ordinal: number;
          revision_id: string;
          team_id: string;
        };
        Update: {
          ad_end?: number;
          ad_start?: number;
          budget_usd?: number;
          name?: string;
          ordinal?: number;
          revision_id?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_campaigns_revision_id_team_id_fkey';
            columns: ['revision_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launch_revisions';
            referencedColumns: ['id', 'team_id'];
          }
        ];
      };
      team_launch_defaults: {
        Row: {
          config: NonNullable<Json>;
          schema_version: number;
          sub_config: NonNullable<Json>;
          team_id: string;
          updated_at: string;
          updated_by: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          config?: NonNullable<Json>;
          schema_version?: number;
          sub_config?: NonNullable<Json>;
          team_id: string;
          updated_at?: string;
          updated_by: string;
          version?: number;
        };
        Update: {
          config?: NonNullable<Json>;
          schema_version?: number;
          sub_config?: NonNullable<Json>;
          team_id?: string;
          updated_at?: string;
          updated_by?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_defaults_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: true;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launch_offer_defaults: {
        Row: {
          config: NonNullable<Json>;
          offer_id: string;
          sub_config: NonNullable<Json>;
          team_id: string;
          updated_at: string;
          updated_by: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          config?: NonNullable<Json>;
          offer_id: string;
          sub_config?: NonNullable<Json>;
          team_id: string;
          updated_at?: string;
          updated_by: string;
          version?: number;
        };
        Update: {
          config?: NonNullable<Json>;
          offer_id?: string;
          sub_config?: NonNullable<Json>;
          team_id?: string;
          updated_at?: string;
          updated_by?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_offer_defaults_offer_id_team_id_fkey';
            columns: ['offer_id', 'team_id'];
            isOneToOne: true;
            referencedRelation: 'team_launch_offers';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_launch_offer_defaults_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launch_generation_steps: {
        Row: {
          attempt_no: number;
          checkpoint: NonNullable<Json>;
          created_at: string;
          fence: number;
          generation_id: string;
          id: string;
          input_signature: string | null;
          provider_file_id: string | null;
          provider_intent_key: string | null;
          reserved_variant: number | null;
          result_material_id: string | null;
          safe_error_code: string | null;
          stable_step_key: string;
          stage: string;
          state: string;
          team_id: string;
          team_operation_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempt_no?: number;
          checkpoint?: NonNullable<Json>;
          created_at?: string;
          fence?: number;
          generation_id: string;
          id?: string;
          input_signature?: string | null;
          provider_file_id?: string | null;
          provider_intent_key?: string | null;
          reserved_variant?: number | null;
          result_material_id?: string | null;
          safe_error_code?: string | null;
          stable_step_key: string;
          stage: string;
          state?: string;
          team_id: string;
          team_operation_id?: string | null;
          updated_at?: string;
        };
        Update: {
          attempt_no?: number;
          checkpoint?: NonNullable<Json>;
          created_at?: string;
          fence?: number;
          generation_id?: string;
          id?: string;
          input_signature?: string | null;
          provider_file_id?: string | null;
          provider_intent_key?: string | null;
          reserved_variant?: number | null;
          result_material_id?: string | null;
          safe_error_code?: string | null;
          stable_step_key?: string;
          stage?: string;
          state?: string;
          team_id?: string;
          team_operation_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_generation_steps_generation_id_team_id_fkey';
            columns: ['generation_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'analytics_launch_generations';
            referencedColumns: ['generation_id', 'team_id'];
          },
          {
            foreignKeyName: 'team_launch_generation_steps_generation_id_team_id_fkey';
            columns: ['generation_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launch_generations';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_launch_generation_steps_team_operation_id_fkey';
            columns: ['team_operation_id'];
            isOneToOne: false;
            referencedRelation: 'team_operations';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launch_generations: {
        Row: {
          actor_id: string;
          attempt_no: number;
          cancel_requested_at: string | null;
          catalog_retry_from_attempt: number | null;
          created_at: string;
          fence: number;
          id: string;
          input_version: string;
          launch_id: string;
          lease_expires_at: string | null;
          lease_owner: string | null;
          next_attempt_at: string | null;
          progress: Json | null;
          request_digest: string;
          request_key: string;
          retryable: boolean;
          revision_id: string;
          safe_error_code: string | null;
          stage: string;
          state: string;
          state_version: number;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          attempt_no?: number;
          cancel_requested_at?: string | null;
          catalog_retry_from_attempt?: number | null;
          created_at?: string;
          fence?: number;
          id?: string;
          input_version: string;
          launch_id: string;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          next_attempt_at?: string | null;
          progress?: Json | null;
          request_digest: string;
          request_key: string;
          retryable?: boolean;
          revision_id: string;
          safe_error_code?: string | null;
          stage?: string;
          state?: string;
          state_version?: number;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          actor_id?: string;
          attempt_no?: number;
          cancel_requested_at?: string | null;
          catalog_retry_from_attempt?: number | null;
          created_at?: string;
          fence?: number;
          id?: string;
          input_version?: string;
          launch_id?: string;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          next_attempt_at?: string | null;
          progress?: Json | null;
          request_digest?: string;
          request_key?: string;
          retryable?: boolean;
          revision_id?: string;
          safe_error_code?: string | null;
          stage?: string;
          state?: string;
          state_version?: number;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_generations_launch_id_team_id_fkey';
            columns: ['launch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launches';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_launch_generations_revision_id_launch_id_team_id_fkey';
            columns: ['revision_id', 'launch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launch_revisions';
            referencedColumns: ['id', 'launch_id', 'team_id'];
          }
        ];
      };
      team_launch_member_preferences: {
        Row: {
          suppress_catalog_retention_warning: boolean;
          team_id: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          suppress_catalog_retention_warning?: boolean;
          team_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          suppress_catalog_retention_warning?: boolean;
          team_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_member_preferences_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launch_offers: {
        Row: {
          archived_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          name: string;
          normalized_key: string;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          created_by: string;
          id?: string;
          name: string;
          normalized_key: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          name?: string;
          normalized_key?: string;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_offers_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launch_requests: {
        Row: {
          action: string;
          actor_id: string;
          created_at: string;
          digest: string;
          request_key: string;
          result: NonNullable<Json>;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_id: string;
          created_at?: string;
          digest: string;
          request_key: string;
          result: NonNullable<Json>;
          team_id: string;
        };
        Update: {
          action?: string;
          actor_id?: string;
          created_at?: string;
          digest?: string;
          request_key?: string;
          result?: NonNullable<Json>;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_requests_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launch_revision_catalogs: {
        Row: {
          catalog_id: string;
          material_id: string;
          name_snapshot: string;
          restitch_material_id: string | null;
          restitch_operation_id: string | null;
          revision_id: string;
          settings_snapshot: NonNullable<Json>;
          sheet_url: string;
          team_id: string;
          variant: number;
        };
        ComputedFields: never;
        Insert: {
          catalog_id: string;
          material_id: string;
          name_snapshot: string;
          restitch_material_id?: string | null;
          restitch_operation_id?: string | null;
          revision_id: string;
          settings_snapshot: NonNullable<Json>;
          sheet_url: string;
          team_id: string;
          variant: number;
        };
        Update: {
          catalog_id?: string;
          material_id?: string;
          name_snapshot?: string;
          restitch_material_id?: string | null;
          restitch_operation_id?: string | null;
          revision_id?: string;
          settings_snapshot?: NonNullable<Json>;
          sheet_url?: string;
          team_id?: string;
          variant?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_revision_catalogs_revision_id_team_id_fkey';
            columns: ['revision_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launch_revisions';
            referencedColumns: ['id', 'team_id'];
          }
        ];
      };
      team_launch_revisions: {
        Row: {
          base_revision_id: string | null;
          baseline_revision_id: string | null;
          config: NonNullable<Json>;
          created_at: string;
          created_by: string;
          generated_url: string;
          generator_versions: NonNullable<Json>;
          id: string;
          launch_id: string;
          original_url: string;
          result_kind: string;
          result_overrides: NonNullable<Json>;
          revision_no: number;
          sources: NonNullable<Json>;
          sub_values: NonNullable<Json>;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          base_revision_id?: string | null;
          baseline_revision_id?: string | null;
          config: NonNullable<Json>;
          created_at?: string;
          created_by: string;
          generated_url: string;
          generator_versions?: NonNullable<Json>;
          id?: string;
          launch_id: string;
          original_url: string;
          result_kind: string;
          result_overrides?: NonNullable<Json>;
          revision_no: number;
          sources: NonNullable<Json>;
          sub_values: NonNullable<Json>;
          team_id: string;
        };
        Update: {
          base_revision_id?: string | null;
          baseline_revision_id?: string | null;
          config?: NonNullable<Json>;
          created_at?: string;
          created_by?: string;
          generated_url?: string;
          generator_versions?: NonNullable<Json>;
          id?: string;
          launch_id?: string;
          original_url?: string;
          result_kind?: string;
          result_overrides?: NonNullable<Json>;
          revision_no?: number;
          sources?: NonNullable<Json>;
          sub_values?: NonNullable<Json>;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_revisions_base_revision_id_launch_id_team_id_fkey';
            columns: ['base_revision_id', 'launch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launch_revisions';
            referencedColumns: ['id', 'launch_id', 'team_id'];
          },
          {
            foreignKeyName: 'team_launch_revisions_baseline_revision_id_launch_id_team__fkey';
            columns: ['baseline_revision_id', 'launch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launch_revisions';
            referencedColumns: ['id', 'launch_id', 'team_id'];
          },
          {
            foreignKeyName: 'team_launch_revisions_launch_id_team_id_fkey';
            columns: ['launch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launches';
            referencedColumns: ['id', 'team_id'];
          }
        ];
      };
      team_launch_signals: {
        Row: {
          launch_id: string;
          team_id: string;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          launch_id: string;
          team_id: string;
          updated_at?: string;
          version: number;
        };
        Update: {
          launch_id?: string;
          team_id?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_signals_launch_id_team_id_fkey';
            columns: ['launch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launches';
            referencedColumns: ['id', 'team_id'];
          }
        ];
      };
      team_launch_workspace_signals: {
        Row: {
          team_id: string;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          team_id: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          team_id?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launch_workspace_signals_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: true;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_launches: {
        Row: {
          active_revision_id: string | null;
          aggregate_version: number;
          archived_at: string | null;
          assignee_id: string | null;
          assignee_label_snapshot: string | null;
          copied_from_launch_id: string | null;
          copied_from_revision_id: string | null;
          created_at: string;
          created_by: string;
          draft_config: NonNullable<Json>;
          draft_version: number;
          effective_launch_date: string | null;
          expected_source_snapshot: Json | null;
          id: string;
          team_id: string;
          updated_at: string;
          work_status: string;
        };
        ComputedFields: never;
        Insert: {
          active_revision_id?: string | null;
          aggregate_version?: number;
          archived_at?: string | null;
          assignee_id?: string | null;
          assignee_label_snapshot?: string | null;
          copied_from_launch_id?: string | null;
          copied_from_revision_id?: string | null;
          created_at?: string;
          created_by: string;
          draft_config?: NonNullable<Json>;
          draft_version?: number;
          effective_launch_date?: string | null;
          expected_source_snapshot?: Json | null;
          id?: string;
          team_id: string;
          updated_at?: string;
          work_status?: string;
        };
        Update: {
          active_revision_id?: string | null;
          aggregate_version?: number;
          archived_at?: string | null;
          assignee_id?: string | null;
          assignee_label_snapshot?: string | null;
          copied_from_launch_id?: string | null;
          copied_from_revision_id?: string | null;
          created_at?: string;
          created_by?: string;
          draft_config?: NonNullable<Json>;
          draft_version?: number;
          effective_launch_date?: string | null;
          expected_source_snapshot?: Json | null;
          id?: string;
          team_id?: string;
          updated_at?: string;
          work_status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_launches_active_revision_id_id_team_id_fkey';
            columns: ['active_revision_id', 'id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launch_revisions';
            referencedColumns: ['id', 'launch_id', 'team_id'];
          },
          {
            foreignKeyName: 'team_launches_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_library_requirements: {
        Row: {
          completed_at: string | null;
          created_at: string;
          current_result_id: string | null;
          id: string;
          kind: string;
          last_error_code: string | null;
          source_material_id: string;
          source_version: string;
          state: string;
          team_id: string;
          updated_at: string;
          variant: string;
        };
        ComputedFields: never;
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          current_result_id?: string | null;
          id?: string;
          kind: string;
          last_error_code?: string | null;
          source_material_id: string;
          source_version: string;
          state?: string;
          team_id: string;
          updated_at?: string;
          variant: string;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          current_result_id?: string | null;
          id?: string;
          kind?: string;
          last_error_code?: string | null;
          source_material_id?: string;
          source_version?: string;
          state?: string;
          team_id?: string;
          updated_at?: string;
          variant?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_library_requirements_current_result_fk';
            columns: ['current_result_id'];
            isOneToOne: false;
            referencedRelation: 'team_library_results';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_library_requirements_source_fk';
            columns: ['source_material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_library_requirements_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_library_results: {
        Row: {
          accepted_attempt_id: string;
          accepted_by: string;
          created_at: string;
          id: string;
          kind: string;
          material_id: string;
          requirement_id: string;
          source_material_id: string;
          source_version: string;
          stale_at: string | null;
          state: string;
          team_id: string;
          variant: string;
        };
        ComputedFields: never;
        Insert: {
          accepted_attempt_id: string;
          accepted_by: string;
          created_at?: string;
          id?: string;
          kind: string;
          material_id: string;
          requirement_id: string;
          source_material_id: string;
          source_version: string;
          stale_at?: string | null;
          state?: string;
          team_id: string;
          variant: string;
        };
        Update: {
          accepted_attempt_id?: string;
          accepted_by?: string;
          created_at?: string;
          id?: string;
          kind?: string;
          material_id?: string;
          requirement_id?: string;
          source_material_id?: string;
          source_version?: string;
          stale_at?: string | null;
          state?: string;
          team_id?: string;
          variant?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_library_results_material_fk';
            columns: ['material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_library_results_requirement_fk';
            columns: ['requirement_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_library_requirements';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_library_results_source_fk';
            columns: ['source_material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_library_results_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_material_links: {
        Row: {
          created_at: string;
          created_by: string;
          derivative_material_id: string;
          id: string;
          relation: string;
          source_material_id: string;
          source_name_snapshot: string;
          team_id: string;
          tool_contract_version: number | null;
          tool_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by: string;
          derivative_material_id: string;
          id?: string;
          relation: string;
          source_material_id: string;
          source_name_snapshot: string;
          team_id: string;
          tool_contract_version?: number | null;
          tool_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          derivative_material_id?: string;
          id?: string;
          relation?: string;
          source_material_id?: string;
          source_name_snapshot?: string;
          team_id?: string;
          tool_contract_version?: number | null;
          tool_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_material_links_derivative_fk';
            columns: ['derivative_material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_material_links_source_fk';
            columns: ['source_material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_material_links_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_material_restitch_prep: {
        Row: {
          detected_end_seconds: number;
          detected_start_seconds: number;
          detector_version: number;
          drive_version: string;
          material_id: string;
          prepared_at: string;
          prepared_by: string | null;
          source_profile: Json | null;
          team_id: string;
          unsupported_reason: string | null;
        };
        ComputedFields: never;
        Insert: {
          detected_end_seconds?: number;
          detected_start_seconds?: number;
          detector_version?: number;
          drive_version: string;
          material_id: string;
          prepared_at?: string;
          prepared_by?: string | null;
          source_profile?: Json | null;
          team_id: string;
          unsupported_reason?: string | null;
        };
        Update: {
          detected_end_seconds?: number;
          detected_start_seconds?: number;
          detector_version?: number;
          drive_version?: string;
          material_id?: string;
          prepared_at?: string;
          prepared_by?: string | null;
          source_profile?: Json | null;
          team_id?: string;
          unsupported_reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_material_restitch_prep_material_id_fkey';
            columns: ['material_id'];
            isOneToOne: true;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_material_restitch_prep_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_materials: {
        Row: {
          audio_fingerprint: string | null;
          catalog_mutation_xid: number;
          category: string | null;
          checksum: string | null;
          classification_source: string;
          classification_version: number;
          companion_kind: string | null;
          companion_of: string | null;
          connection_id: string;
          created_at: string;
          drive_file_id: string;
          drive_id: string | null;
          drive_version: string | null;
          file_extension: string | null;
          folder_indexed_at: string | null;
          folder_trash_root: string | null;
          geo: string | null;
          id: string;
          kind: string;
          landing_inspection_claimed_at: string | null;
          landing_validation_fingerprint: string | null;
          landing_validation_state: string | null;
          landing_validation_version: string | null;
          language: string | null;
          language_decision_revision: number;
          language_decision_source: string | null;
          library_stage: string | null;
          lifecycle: string;
          mime_type: string | null;
          missing_at: string | null;
          missing_reason: string | null;
          modified_at: string | null;
          name: string;
          note: string | null;
          offer: string | null;
          parent_folder_id: string | null;
          placement_revision: number;
          placement_state: string;
          preview_error_code: string | null;
          preview_state: string;
          provider_thumbnail_claimed_at: string | null;
          provider_thumbnail_reason: string | null;
          provider_thumbnail_state: string;
          provider_thumbnail_version: string | null;
          resource_key: string | null;
          search_tsv: unknown;
          selection_id: string | null;
          shortcut_target_id: string | null;
          shortcut_target_resource_key: string | null;
          size_bytes: number | null;
          structural_language: string | null;
          structural_offer: string | null;
          structural_type: string | null;
          tag_color: string | null;
          tags: string[];
          team_id: string;
          thumbnail_source_version: string | null;
          thumbnail_state: string;
          thumbnail_time_ms: number | null;
          transcript_error_code: string | null;
          transcript_indexed_bytes: number;
          transcript_ingest_state: string;
          transcript_ingested_at: string | null;
          transcript_source_checksum: string | null;
          transcript_source_version: string | null;
          transcript_text: string | null;
          transcript_truncated: boolean;
          trashed_at: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          audio_fingerprint?: string | null;
          catalog_mutation_xid?: number;
          category?: string | null;
          checksum?: string | null;
          classification_source?: string;
          classification_version?: number;
          companion_kind?: string | null;
          companion_of?: string | null;
          connection_id: string;
          created_at?: string;
          drive_file_id: string;
          drive_id?: string | null;
          drive_version?: string | null;
          file_extension?: string | null;
          folder_indexed_at?: string | null;
          folder_trash_root?: string | null;
          geo?: string | null;
          id?: string;
          kind: string;
          landing_inspection_claimed_at?: string | null;
          landing_validation_fingerprint?: string | null;
          landing_validation_state?: string | null;
          landing_validation_version?: string | null;
          language?: string | null;
          language_decision_revision?: number;
          language_decision_source?: string | null;
          library_stage?: string | null;
          lifecycle?: string;
          mime_type?: string | null;
          missing_at?: string | null;
          missing_reason?: string | null;
          modified_at?: string | null;
          name: string;
          note?: string | null;
          offer?: string | null;
          parent_folder_id?: string | null;
          placement_revision?: number;
          placement_state?: string;
          preview_error_code?: string | null;
          preview_state?: string;
          provider_thumbnail_claimed_at?: string | null;
          provider_thumbnail_reason?: string | null;
          provider_thumbnail_state?: string;
          provider_thumbnail_version?: string | null;
          resource_key?: string | null;
          search_tsv?: unknown;
          selection_id?: string | null;
          shortcut_target_id?: string | null;
          shortcut_target_resource_key?: string | null;
          size_bytes?: number | null;
          structural_language?: string | null;
          structural_offer?: string | null;
          structural_type?: string | null;
          tag_color?: string | null;
          tags?: string[];
          team_id: string;
          thumbnail_source_version?: string | null;
          thumbnail_state?: string;
          thumbnail_time_ms?: number | null;
          transcript_error_code?: string | null;
          transcript_indexed_bytes?: number;
          transcript_ingest_state?: string;
          transcript_ingested_at?: string | null;
          transcript_source_checksum?: string | null;
          transcript_source_version?: string | null;
          transcript_text?: string | null;
          transcript_truncated?: boolean;
          trashed_at?: string | null;
          updated_at?: string;
        };
        Update: {
          audio_fingerprint?: string | null;
          catalog_mutation_xid?: number;
          category?: string | null;
          checksum?: string | null;
          classification_source?: string;
          classification_version?: number;
          companion_kind?: string | null;
          companion_of?: string | null;
          connection_id?: string;
          created_at?: string;
          drive_file_id?: string;
          drive_id?: string | null;
          drive_version?: string | null;
          file_extension?: string | null;
          folder_indexed_at?: string | null;
          folder_trash_root?: string | null;
          geo?: string | null;
          id?: string;
          kind?: string;
          landing_inspection_claimed_at?: string | null;
          landing_validation_fingerprint?: string | null;
          landing_validation_state?: string | null;
          landing_validation_version?: string | null;
          language?: string | null;
          language_decision_revision?: number;
          language_decision_source?: string | null;
          library_stage?: string | null;
          lifecycle?: string;
          mime_type?: string | null;
          missing_at?: string | null;
          missing_reason?: string | null;
          modified_at?: string | null;
          name?: string;
          note?: string | null;
          offer?: string | null;
          parent_folder_id?: string | null;
          placement_revision?: number;
          placement_state?: string;
          preview_error_code?: string | null;
          preview_state?: string;
          provider_thumbnail_claimed_at?: string | null;
          provider_thumbnail_reason?: string | null;
          provider_thumbnail_state?: string;
          provider_thumbnail_version?: string | null;
          resource_key?: string | null;
          search_tsv?: unknown;
          selection_id?: string | null;
          shortcut_target_id?: string | null;
          shortcut_target_resource_key?: string | null;
          size_bytes?: number | null;
          structural_language?: string | null;
          structural_offer?: string | null;
          structural_type?: string | null;
          tag_color?: string | null;
          tags?: string[];
          team_id?: string;
          thumbnail_source_version?: string | null;
          thumbnail_state?: string;
          thumbnail_time_ms?: number | null;
          transcript_error_code?: string | null;
          transcript_indexed_bytes?: number;
          transcript_ingest_state?: string;
          transcript_ingested_at?: string | null;
          transcript_source_checksum?: string | null;
          transcript_source_version?: string | null;
          transcript_text?: string | null;
          transcript_truncated?: boolean;
          trashed_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_materials_companion_of_fk';
            columns: ['companion_of'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_materials_connection_id_fkey';
            columns: ['connection_id'];
            isOneToOne: false;
            referencedRelation: 'team_drive_connections';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_materials_folder_trash_root_fkey';
            columns: ['folder_trash_root'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_materials_geo_fkey';
            columns: ['geo'];
            isOneToOne: false;
            referencedRelation: 'geo_options';
            referencedColumns: ['code'];
          },
          {
            foreignKeyName: 'team_materials_language_fkey';
            columns: ['language'];
            isOneToOne: false;
            referencedRelation: 'language_options';
            referencedColumns: ['code'];
          },
          {
            foreignKeyName: 'team_materials_selection_id_fkey';
            columns: ['selection_id'];
            isOneToOne: false;
            referencedRelation: 'team_drive_selections';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_materials_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_member_restitch_preferences: {
        Row: {
          configured: boolean;
          custom_final_duration_seconds: number;
          custom_start_duration_ms: number;
          end_enabled: boolean;
          end_image_ids: string[];
          final_duration_mode: string;
          fit_mode: string;
          operation: string;
          source_mode: string;
          start_duration_mode: string;
          start_enabled: boolean;
          start_image_ids: string[];
          team_id: string;
          updated_at: string;
          use_owner: boolean;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          configured?: boolean;
          custom_final_duration_seconds?: number;
          custom_start_duration_ms?: number;
          end_enabled?: boolean;
          end_image_ids?: string[];
          final_duration_mode?: string;
          fit_mode?: string;
          operation?: string;
          source_mode?: string;
          start_duration_mode?: string;
          start_enabled?: boolean;
          start_image_ids?: string[];
          team_id: string;
          updated_at?: string;
          use_owner?: boolean;
          user_id: string;
        };
        Update: {
          configured?: boolean;
          custom_final_duration_seconds?: number;
          custom_start_duration_ms?: number;
          end_enabled?: boolean;
          end_image_ids?: string[];
          final_duration_mode?: string;
          fit_mode?: string;
          operation?: string;
          source_mode?: string;
          start_duration_mode?: string;
          start_enabled?: boolean;
          start_image_ids?: string[];
          team_id?: string;
          updated_at?: string;
          use_owner?: boolean;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_member_restitch_preferences_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_members: {
        Row: {
          base_role: string;
          created_at: string;
          id: string;
          joined_at: string;
          permission_overrides: NonNullable<Json>;
          removed_at: string | null;
          status: string;
          team_id: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          base_role: string;
          created_at?: string;
          id?: string;
          joined_at?: string;
          permission_overrides?: NonNullable<Json>;
          removed_at?: string | null;
          status?: string;
          team_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          base_role?: string;
          created_at?: string;
          id?: string;
          joined_at?: string;
          permission_overrides?: NonNullable<Json>;
          removed_at?: string | null;
          status?: string;
          team_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_members_base_role_fkey';
            columns: ['base_role'];
            isOneToOne: false;
            referencedRelation: 'team_roles';
            referencedColumns: ['role'];
          },
          {
            foreignKeyName: 'team_members_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_membership_access_signals: {
        Row: {
          changed_at: string;
          revision: number;
          team_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          changed_at?: string;
          revision?: number;
          team_id: string;
          user_id: string;
        };
        Update: {
          changed_at?: string;
          revision?: number;
          team_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_membership_access_signals_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_operations: {
        Row: {
          actor_id: string;
          bytes_completed: number;
          bytes_total: number | null;
          created_at: string;
          destination_folder_id: string | null;
          error_code: string | null;
          finished_at: string | null;
          id: string;
          idempotency_key: string;
          kind: string;
          progress: number;
          request_nonce: string;
          reservation_expires_at: string | null;
          reservation_released_at: string | null;
          reserved_name_key: string | null;
          result_material_id: string | null;
          retryable: boolean;
          source_material_id: string | null;
          stage: string | null;
          state: string;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          bytes_completed?: number;
          bytes_total?: number | null;
          created_at?: string;
          destination_folder_id?: string | null;
          error_code?: string | null;
          finished_at?: string | null;
          id?: string;
          idempotency_key: string;
          kind: string;
          progress?: number;
          request_nonce: string;
          reservation_expires_at?: string | null;
          reservation_released_at?: string | null;
          reserved_name_key?: string | null;
          result_material_id?: string | null;
          retryable?: boolean;
          source_material_id?: string | null;
          stage?: string | null;
          state?: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          actor_id?: string;
          bytes_completed?: number;
          bytes_total?: number | null;
          created_at?: string;
          destination_folder_id?: string | null;
          error_code?: string | null;
          finished_at?: string | null;
          id?: string;
          idempotency_key?: string;
          kind?: string;
          progress?: number;
          request_nonce?: string;
          reservation_expires_at?: string | null;
          reservation_released_at?: string | null;
          reserved_name_key?: string | null;
          result_material_id?: string | null;
          retryable?: boolean;
          source_material_id?: string | null;
          stage?: string | null;
          state?: string;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_operations_destination_folder_id_fkey';
            columns: ['destination_folder_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_operations_result_material_id_fkey';
            columns: ['result_material_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_operations_source_material_id_fkey';
            columns: ['source_material_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_operations_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_permissions: {
        Row: {
          permission: string;
        };
        ComputedFields: never;
        Insert: {
          permission: string;
        };
        Update: {
          permission?: string;
        };
        Relationships: [];
      };
      team_product_catalog_image_sources: {
        Row: {
          created_at: string;
          kind: string;
          material_id: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          kind: string;
          material_id: string;
          team_id: string;
        };
        Update: {
          created_at?: string;
          kind?: string;
          material_id?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_product_catalog_image_sources_material_id_team_id_fkey';
            columns: ['material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_product_catalog_image_sources_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_product_catalog_settings: {
        Row: {
          created_at: string;
          description: string | null;
          image_link: string | null;
          price: number;
          price_max: number | null;
          price_min: number | null;
          team_id: string;
          title: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          description?: string | null;
          image_link?: string | null;
          price: number;
          price_max?: number | null;
          price_min?: number | null;
          team_id: string;
          title?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          image_link?: string | null;
          price?: number;
          price_max?: number | null;
          price_min?: number | null;
          team_id?: string;
          title?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_product_catalog_settings_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: true;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_product_catalog_texts: {
        Row: {
          description: string;
          id: string;
          position: number;
          team_id: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          description: string;
          id?: string;
          position: number;
          team_id: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          description?: string;
          id?: string;
          position?: number;
          team_id?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_product_catalog_texts_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_product_catalogs: {
        Row: {
          created_at: string;
          created_by: string | null;
          current_video_link: string | null;
          last_update_error: string | null;
          last_update_error_at: string | null;
          last_updated_at: string | null;
          material_id: string;
          product_count: number;
          settings_snapshot: NonNullable<Json>;
          sheet_url: string;
          source_link: string;
          team_id: string;
          update_count: number;
          variant: number | null;
          video_link: string;
          video_material_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          current_video_link?: string | null;
          last_update_error?: string | null;
          last_update_error_at?: string | null;
          last_updated_at?: string | null;
          material_id: string;
          product_count: number;
          settings_snapshot: NonNullable<Json>;
          sheet_url: string;
          source_link: string;
          team_id: string;
          update_count?: number;
          variant?: number | null;
          video_link: string;
          video_material_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          current_video_link?: string | null;
          last_update_error?: string | null;
          last_update_error_at?: string | null;
          last_updated_at?: string | null;
          material_id?: string;
          product_count?: number;
          settings_snapshot?: NonNullable<Json>;
          sheet_url?: string;
          source_link?: string;
          team_id?: string;
          update_count?: number;
          variant?: number | null;
          video_link?: string;
          video_material_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_product_catalogs_material_id_fkey';
            columns: ['material_id'];
            isOneToOne: true;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_product_catalogs_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_product_catalogs_video_material_id_fkey';
            columns: ['video_material_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          }
        ];
      };
      team_restitch_defaults: {
        Row: {
          configured: boolean;
          created_at: string;
          custom_final_duration_seconds: number;
          custom_start_duration_ms: number;
          end_enabled: boolean;
          end_image_ids: string[];
          final_duration_mode: string;
          fit_mode: string;
          operation: string;
          source_mode: string;
          start_duration_mode: string;
          start_enabled: boolean;
          start_image_ids: string[];
          team_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          configured?: boolean;
          created_at?: string;
          custom_final_duration_seconds?: number;
          custom_start_duration_ms?: number;
          end_enabled?: boolean;
          end_image_ids?: string[];
          final_duration_mode?: string;
          fit_mode?: string;
          operation?: string;
          source_mode?: string;
          start_duration_mode?: string;
          start_enabled?: boolean;
          start_image_ids?: string[];
          team_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          configured?: boolean;
          created_at?: string;
          custom_final_duration_seconds?: number;
          custom_start_duration_ms?: number;
          end_enabled?: boolean;
          end_image_ids?: string[];
          final_duration_mode?: string;
          fit_mode?: string;
          operation?: string;
          source_mode?: string;
          start_duration_mode?: string;
          start_enabled?: boolean;
          start_image_ids?: string[];
          team_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_restitch_defaults_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: true;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_restitch_sources: {
        Row: {
          added_at: string;
          added_by: string | null;
          drive_file_id: string | null;
          id: string;
          kind: string;
          material_id: string | null;
          slot: string;
          sort_order: number;
          team_id: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          added_at?: string;
          added_by?: string | null;
          drive_file_id?: string | null;
          id?: string;
          kind: string;
          material_id?: string | null;
          slot: string;
          sort_order?: number;
          team_id: string;
          user_id?: string | null;
        };
        Update: {
          added_at?: string;
          added_by?: string | null;
          drive_file_id?: string | null;
          id?: string;
          kind?: string;
          material_id?: string | null;
          slot?: string;
          sort_order?: number;
          team_id?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_restitch_sources_material_id_fkey';
            columns: ['material_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_restitch_sources_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_roles: {
        Row: {
          is_base_role: boolean;
          role: string;
        };
        ComputedFields: never;
        Insert: {
          is_base_role: boolean;
          role: string;
        };
        Update: {
          is_base_role?: boolean;
          role?: string;
        };
        Relationships: [];
      };
      team_share_preferences: {
        Row: {
          allow_link_on_copy: boolean;
          created_at: string;
          team_id: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          allow_link_on_copy?: boolean;
          created_at?: string;
          team_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          allow_link_on_copy?: boolean;
          created_at?: string;
          team_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_share_preferences_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_task_agents: {
        Row: {
          account_id: string;
          account_name_snapshot: string;
          agent_row_id: string;
          attached_at: string;
          attached_by: string;
          id: string;
          task_id: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          account_name_snapshot: string;
          agent_row_id: string;
          attached_at?: string;
          attached_by: string;
          id?: string;
          task_id: string;
          team_id: string;
        };
        Update: {
          account_id?: string;
          account_name_snapshot?: string;
          agent_row_id?: string;
          attached_at?: string;
          attached_by?: string;
          id?: string;
          task_id?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_task_agents_agent_row_id_team_id_fkey';
            columns: ['agent_row_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_account_agents';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_task_agents_task_id_team_id_fkey';
            columns: ['task_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_tasks';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_task_agents_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_task_attachments: {
        Row: {
          attached_at: string;
          attached_by: string;
          id: string;
          material_id: string;
          position: number;
          task_id: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          attached_at?: string;
          attached_by: string;
          id?: string;
          material_id: string;
          position: number;
          task_id: string;
          team_id: string;
        };
        Update: {
          attached_at?: string;
          attached_by?: string;
          id?: string;
          material_id?: string;
          position?: number;
          task_id?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_task_attachments_material_fk';
            columns: ['material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_task_attachments_task_fk';
            columns: ['task_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_tasks';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_task_attachments_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_task_label_links: {
        Row: {
          attached_at: string;
          attached_by: string;
          id: string;
          label_id: string;
          task_id: string;
          team_id: string;
        };
        ComputedFields: never;
        Insert: {
          attached_at?: string;
          attached_by: string;
          id?: string;
          label_id: string;
          task_id: string;
          team_id: string;
        };
        Update: {
          attached_at?: string;
          attached_by?: string;
          id?: string;
          label_id?: string;
          task_id?: string;
          team_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_task_label_links_label_id_team_id_fkey';
            columns: ['label_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_labels';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_task_label_links_task_id_team_id_fkey';
            columns: ['task_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_tasks';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_task_label_links_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_tasks: {
        Row: {
          assignee_id: string | null;
          assignee_label_snapshot: string | null;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          note: string | null;
          progress_manually_set: boolean;
          progress_max: number;
          progress_value: number;
          status: string;
          task_date: string | null;
          team_id: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          assignee_id?: string | null;
          assignee_label_snapshot?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by: string;
          id?: string;
          note?: string | null;
          progress_manually_set?: boolean;
          progress_max?: number;
          progress_value?: number;
          status?: string;
          task_date?: string | null;
          team_id: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          assignee_id?: string | null;
          assignee_label_snapshot?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          note?: string | null;
          progress_manually_set?: boolean;
          progress_max?: number;
          progress_value?: number;
          status?: string;
          task_date?: string | null;
          team_id?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_tasks_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_upload_batch_items: {
        Row: {
          batch_id: string;
          client_item_key: string;
          created_at: string;
          error_code: string | null;
          finished_at: string | null;
          id: string;
          material_id: string | null;
          mime_type: string;
          operation_id: string | null;
          progress: number;
          requested_name: string;
          size_bytes: number;
          state: string;
          team_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          batch_id: string;
          client_item_key: string;
          created_at?: string;
          error_code?: string | null;
          finished_at?: string | null;
          id?: string;
          material_id?: string | null;
          mime_type: string;
          operation_id?: string | null;
          progress?: number;
          requested_name: string;
          size_bytes: number;
          state?: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          batch_id?: string;
          client_item_key?: string;
          created_at?: string;
          error_code?: string | null;
          finished_at?: string | null;
          id?: string;
          material_id?: string | null;
          mime_type?: string;
          operation_id?: string | null;
          progress?: number;
          requested_name?: string;
          size_bytes?: number;
          state?: string;
          team_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_upload_batch_items_batch_fk';
            columns: ['batch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_upload_batches';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_upload_batch_items_material_fk';
            columns: ['material_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_materials';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_upload_batch_items_operation_id_fkey';
            columns: ['operation_id'];
            isOneToOne: true;
            referencedRelation: 'team_operations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_upload_batch_items_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_upload_batches: {
        Row: {
          actor_id: string;
          created_at: string;
          failed_items: number;
          finished_at: string | null;
          geo: string;
          id: string;
          language: string | null;
          language_mode: string;
          offer: string;
          stage: string;
          state: string;
          succeeded_items: number;
          team_id: string;
          total_items: number;
          type_hint: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          created_at?: string;
          failed_items?: number;
          finished_at?: string | null;
          geo: string;
          id?: string;
          language?: string | null;
          language_mode: string;
          offer: string;
          stage: string;
          state?: string;
          succeeded_items?: number;
          team_id: string;
          total_items: number;
          type_hint?: string | null;
          updated_at?: string;
        };
        Update: {
          actor_id?: string;
          created_at?: string;
          failed_items?: number;
          finished_at?: string | null;
          geo?: string;
          id?: string;
          language?: string | null;
          language_mode?: string;
          offer?: string;
          stage?: string;
          state?: string;
          succeeded_items?: number;
          team_id?: string;
          total_items?: number;
          type_hint?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_upload_batches_geo_fkey';
            columns: ['geo'];
            isOneToOne: false;
            referencedRelation: 'geo_options';
            referencedColumns: ['code'];
          },
          {
            foreignKeyName: 'team_upload_batches_language_fkey';
            columns: ['language'];
            isOneToOne: false;
            referencedRelation: 'language_options';
            referencedColumns: ['code'];
          },
          {
            foreignKeyName: 'team_upload_batches_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_workspace_folders: {
        Row: {
          created_at: string;
          drive_folder_id: string;
          marker: string;
          team_id: string;
          verified_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          drive_folder_id: string;
          marker: string;
          team_id: string;
          verified_at?: string;
        };
        Update: {
          created_at?: string;
          drive_folder_id?: string;
          marker?: string;
          team_id?: string;
          verified_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_workspace_folders_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: true;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      team_workspace_waitlist: {
        Row: {
          admin_note: string | null;
          channel: string | null;
          created_at: string;
          email: string;
          handled_at: string | null;
          last_contact_at: string | null;
          plan_interest: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          admin_note?: string | null;
          channel?: string | null;
          created_at?: string;
          email: string;
          handled_at?: string | null;
          last_contact_at?: string | null;
          plan_interest?: string | null;
          user_id: string;
        };
        Update: {
          admin_note?: string | null;
          channel?: string | null;
          created_at?: string;
          email?: string;
          handled_at?: string | null;
          last_contact_at?: string | null;
          plan_interest?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'team_workspace_waitlist_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'analytics_users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'team_workspace_waitlist_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          }
        ];
      };
      teams: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          owner_id: string;
          status: string;
          task_progress_max_default: number | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          owner_id: string;
          status?: string;
          task_progress_max_default?: number | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          owner_id?: string;
          status?: string;
          task_progress_max_default?: number | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      windows_app_waitlist: {
        Row: {
          created_at: string;
          email: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          email: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          email?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'windows_app_waitlist_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'analytics_users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'windows_app_waitlist_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          }
        ];
      };
    };
    Views: {
      analytics_catalog_settings_coverage: {
        Row: {
          capture_enabled: boolean | null;
          installed_at: string | null;
          schema_version: number | null;
        };
        ComputedFields: never;
        Insert: {
          capture_enabled?: never;
          installed_at?: string | null;
          schema_version?: number | null;
        };
        Update: {
          capture_enabled?: never;
          installed_at?: string | null;
          schema_version?: number | null;
        };
        Relationships: [];
      };
      analytics_catalog_settings_current: {
        Row: {
          catalog_material_id: string | null;
          creator_id: string | null;
          observed_at: string | null;
          profile_version: number | null;
          state: Json | null;
          team_id: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      analytics_catalog_settings_history: {
        Row: {
          actor_id: string | null;
          actor_kind: string | null;
          after_state: Json | null;
          baseline_kind: string | null;
          before_state: Json | null;
          catalog_material_id: string | null;
          changed_fields: string[] | null;
          creator_id: string | null;
          event_id: string | null;
          observed_at: string | null;
          profile_version: number | null;
          source: string | null;
          team_id: string | null;
          transaction_id: number | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          actor_kind?: string | null;
          after_state?: Json | null;
          baseline_kind?: string | null;
          before_state?: Json | null;
          catalog_material_id?: string | null;
          changed_fields?: string[] | null;
          creator_id?: string | null;
          event_id?: string | null;
          observed_at?: string | null;
          profile_version?: number | null;
          source?: string | null;
          team_id?: string | null;
          transaction_id?: number | null;
        };
        Update: {
          actor_id?: string | null;
          actor_kind?: string | null;
          after_state?: Json | null;
          baseline_kind?: string | null;
          before_state?: Json | null;
          catalog_material_id?: string | null;
          changed_fields?: string[] | null;
          creator_id?: string | null;
          event_id?: string | null;
          observed_at?: string | null;
          profile_version?: number | null;
          source?: string | null;
          team_id?: string | null;
          transaction_id?: number | null;
        };
        Relationships: [];
      };
      analytics_catalog_sync_jobs: {
        Row: {
          attempts: number | null;
          cancel_requested_at: string | null;
          canonical_error_code: string | null;
          canonical_job_id: string | null;
          canonical_next_attempt_at: string | null;
          canonical_state: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          confirmed_sequence: number | null;
          connection_id: string | null;
          connection_state: string | null;
          created_at: string | null;
          detached_at: string | null;
          error_detail: string | null;
          files_added: number | null;
          files_listed: number | null;
          files_removed: number | null;
          files_updated: number | null;
          folders_done: number | null;
          items_unavailable: number | null;
          job_id: string | null;
          job_kind: string | null;
          last_error_code: string | null;
          last_progress_at: string | null;
          last_recovery_at: string | null;
          lease_epoch: number | null;
          lease_expires_at: string | null;
          lease_lost_count: number | null;
          next_attempt_at: string | null;
          no_progress_runs: number | null;
          owner_email_normalized: string | null;
          phase: string | null;
          recovery_count: number | null;
          replay_after: number | null;
          request_id: string | null;
          request_key_hash: string | null;
          request_outcome: string | null;
          requested_by: string | null;
          run_count: number | null;
          scan_completed_at: string | null;
          scope_hash: string | null;
          state: string | null;
          team_id: string | null;
          updated_at: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: 'team_drive_connections_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      analytics_catalog_updates: {
        Row: {
          actual_changes: Json | null;
          attempt_id: string | null;
          attempt_schedule: Json | null;
          catalog_material_id: string | null;
          current_profile_version: number | null;
          delivery_verified_at: string | null;
          ended_at: string | null;
          failure_code: string | null;
          last_error_at: string | null;
          last_error_code: string | null;
          last_success_at: string | null;
          next_run_at: string | null;
          profile_version: number | null;
          reconciliation_required: boolean | null;
          result: string | null;
          schedule: Json | null;
          source_attempt_id: string | null;
          stage_history: Json | null;
          started_at: string | null;
          team_id: string | null;
          trigger_kind: string | null;
          update_interval: string | null;
          video_operation_stage: string | null;
          video_operation_state: string | null;
          video_preparation_error: string | null;
          video_preparation_lease_until: string | null;
          video_preparation_retry_at: string | null;
          video_preparation_state: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: 'team_catalog_update_attempts_catalog_material_id_fkey';
            columns: ['catalog_material_id'];
            isOneToOne: false;
            referencedRelation: 'team_product_catalogs';
            referencedColumns: ['material_id'];
          },
          {
            foreignKeyName: 'team_catalog_update_attempts_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      analytics_launch_generations: {
        Row: {
          actor_id: string | null;
          attempt_no: number | null;
          cancel_requested_at: string | null;
          catalog_registered: boolean | null;
          created_at: string | null;
          flow_id: string | null;
          generation_id: string | null;
          launch_id: string | null;
          lease_expires_at: string | null;
          method: string | null;
          next_attempt_at: string | null;
          result_is_active: boolean | null;
          retryable: boolean | null;
          reuse_evidence: Json | null;
          revision_id: string | null;
          safe_error_code: string | null;
          stage: string | null;
          state: string | null;
          state_version: string | null;
          steps: Json | null;
          team_id: string | null;
          updated_at: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: 'team_launch_generations_launch_id_team_id_fkey';
            columns: ['launch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launches';
            referencedColumns: ['id', 'team_id'];
          },
          {
            foreignKeyName: 'team_launch_generations_revision_id_launch_id_team_id_fkey';
            columns: ['revision_id', 'launch_id', 'team_id'];
            isOneToOne: false;
            referencedRelation: 'team_launch_revisions';
            referencedColumns: ['id', 'launch_id', 'team_id'];
          }
        ];
      };
      analytics_membership_access_signals: {
        Row: {
          changed_at: string | null;
          revision: number | null;
          team_id: string | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          changed_at?: string | null;
          revision?: number | null;
          team_id?: string | null;
          user_id?: string | null;
        };
        Update: {
          changed_at?: string | null;
          revision?: number | null;
          team_id?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'team_membership_access_signals_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      analytics_process_output_cleanup: {
        Row: {
          actor_id: string | null;
          attempts: number | null;
          captured_handoff_expires_at: string | null;
          cleanup_state: string | null;
          created_at: string | null;
          id: string | null;
          lease_expires_at: string | null;
          max_attempts: number | null;
          next_attempt_at: string | null;
          provider_material_registered: boolean | null;
          provider_mutation_reserved: boolean | null;
          provider_result_recorded: boolean | null;
          updated_at: string | null;
          upload_state: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          attempts?: number | null;
          captured_handoff_expires_at?: string | null;
          cleanup_state?: string | null;
          created_at?: string | null;
          id?: string | null;
          lease_expires_at?: string | null;
          max_attempts?: never;
          next_attempt_at?: string | null;
          provider_material_registered?: never;
          provider_mutation_reserved?: never;
          provider_result_recorded?: never;
          updated_at?: string | null;
          upload_state?: string | null;
        };
        Update: {
          actor_id?: string | null;
          attempts?: number | null;
          captured_handoff_expires_at?: string | null;
          cleanup_state?: string | null;
          created_at?: string | null;
          id?: string | null;
          lease_expires_at?: string | null;
          max_attempts?: never;
          next_attempt_at?: string | null;
          provider_material_registered?: never;
          provider_mutation_reserved?: never;
          provider_result_recorded?: never;
          updated_at?: string | null;
          upload_state?: string | null;
        };
        Relationships: [];
      };
      analytics_recovery_execution: {
        Row: {
          actor_id: string | null;
          member_ids: string[] | null;
          operation_id: string | null;
          started_at: string | null;
          team_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          member_ids?: never;
          operation_id?: string | null;
          started_at?: string | null;
          team_id?: string | null;
        };
        Update: {
          actor_id?: string | null;
          member_ids?: never;
          operation_id?: string | null;
          started_at?: string | null;
          team_id?: string | null;
        };
        Relationships: [];
      };
      analytics_team_workspace: {
        Row: {
          member_joined_at: string | null;
          member_removed_at: string | null;
          member_user_id: string | null;
          pilot_enrolled_at: string | null;
          pilot_exited_at: string | null;
          root_connected_at: string | null;
          root_state: string | null;
          workspace_key: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      analytics_users: {
        Row: {
          account_status: string | null;
          display_name: string | null;
          email: string | null;
          email_normalized: string | null;
          id: string | null;
          language: string | null;
          last_login_at: string | null;
          last_seen_at: string | null;
          marketing_consent: boolean | null;
          plan: string | null;
          registered_at: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      analytics_workspace_operations: {
        Row: {
          action: string | null;
          actor_id: string | null;
          code: string | null;
          confirmed_count: number | null;
          created_at: string | null;
          id: string | null;
          item_count: number | null;
          state: string | null;
          team_id: string | null;
          updated_at: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      analytics_workspace_recovery: {
        Row: {
          actor_id: string | null;
          attempt_id: string | null;
          attempts: number | null;
          delivered_at: string | null;
          epoch: number | null;
          finished_at: string | null;
          item_id: string | null;
          kind: string | null;
          last_progress_at: string | null;
          member_ids: string[] | null;
          operation_id: string | null;
          reason_code: string | null;
          recovery_id: string | null;
          recovery_state: string | null;
          registered_at: string | null;
          resource_id: string | null;
          stage: string | null;
          started_at: string | null;
          state: string | null;
          team_id: string | null;
          updated_at: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
    };
    Functions: {
      accept_invitation: {
        Args: { p_invitation: string; p_plain_token?: string };
        Returns: {
          connection_state: string;
          id: string;
          name: string;
          permissions: Json;
          role: string;
        }[];
      };
      ack_space_tariff_toast: { Args: { p_event: string }; Returns: boolean };
      add_team_account_agent: {
        Args: {
          p_account: string;
          p_agent_id: string;
          p_note?: string;
          p_starts_on?: string;
          p_team: string;
          p_timezone?: string;
        };
        Returns: Json;
      };
      add_team_agent_run: {
        Args: { p_agent: string; p_note: string; p_team: string };
        Returns: Json;
      };
      add_team_drive_selection: {
        Args: {
          p_drive_folder_id: string;
          p_name?: string;
          p_resource_key?: string;
          p_team: string;
        };
        Returns: {
          drive_folder_id: string;
          id: string;
          is_root: boolean;
          name: string;
          state: string;
        }[];
      };
      admin_active_support_goal: {
        Args: Record<PropertyKey, never>;
        Returns: {
          created_at: string;
          currency: string;
          description_en: string;
          description_uk: string;
          id: string;
          raised_cents: number;
          slug: string;
          status: string;
          target_cents: number;
          title_en: string;
          title_uk: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'support_goals';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      admin_agent_versions: {
        Args: { p_end_date: string; p_start_date: string };
        Returns: {
          agent_version: string;
          total: number;
        }[];
      };
      admin_daily_activity: {
        Args: { p_end_date: string; p_start_date: string };
        Returns: {
          active_users: number;
          activity_date: string;
          event_count: number;
        }[];
      };
      admin_end_space_tariff: { Args: { p_id: string; p_now: boolean }; Returns: Json };
      admin_extend_space_tariff: {
        Args: { p_id: string; p_months: number; p_notify?: boolean };
        Returns: Json;
      };
      admin_get_tariff_settings: { Args: Record<PropertyKey, never>; Returns: Json };
      admin_grant_space_tariff: {
        Args: {
          p_email: string;
          p_ends_on: string;
          p_external_ref?: string;
          p_extra_seats: number;
          p_note?: string;
          p_notify?: boolean;
          p_plan: string;
          p_source?: string;
          p_team?: string;
        };
        Returns: Json;
      };
      admin_list_legacy_spaces: { Args: Record<PropertyKey, never>; Returns: Json };
      admin_list_owner_spaces: { Args: { p_email: string }; Returns: Json };
      admin_list_space_requests: { Args: Record<PropertyKey, never>; Returns: Json };
      admin_list_space_tariff_events: { Args: { p_id: string }; Returns: Json };
      admin_list_space_tariffs: { Args: Record<PropertyKey, never>; Returns: Json };
      admin_list_tariff_plans: { Args: Record<PropertyKey, never>; Returns: Json };
      admin_list_tariff_seats: { Args: { p_team: string }; Returns: Json };
      admin_list_team_workspace_waitlist: {
        Args: Record<PropertyKey, never>;
        Returns: {
          created_at: string;
          email: string;
          user_id: string;
        }[];
      };
      admin_list_users: {
        Args: {
          p_account_status?: string;
          p_limit?: number;
          p_marketing_consent?: boolean;
          p_offset?: number;
          p_search?: string;
        };
        Returns: {
          account_status: string;
          created_at: string;
          display_name: string;
          email: string;
          id: string;
          language: string;
          last_seen_at: string;
          marketing_consent: boolean;
          marketing_consent_at: string;
          plan: string;
          total_count: number;
        }[];
      };
      admin_list_windows_app_waitlist: {
        Args: Record<PropertyKey, never>;
        Returns: {
          created_at: string;
          email: string;
          user_id: string;
        }[];
      };
      admin_mark_space_request: {
        Args: { p_handled: boolean; p_note?: string; p_user: string };
        Returns: boolean;
      };
      admin_marketing_export: {
        Args: Record<PropertyKey, never>;
        Returns: {
          display_name: string;
          email: string;
          language: string;
          marketing_consent_at: string;
        }[];
      };
      admin_overview: { Args: { p_end_date: string; p_start_date: string }; Returns: Json };
      admin_preview_space_tariff: { Args: { p_email: string; p_team?: string }; Returns: Json };
      admin_remove_tariff_member: { Args: { p_team: string; p_user: string }; Returns: boolean };
      admin_revoke_tariff_invitation: { Args: { p_invitation: string }; Returns: boolean };
      admin_set_account_status: {
        Args: { p_account_status: string; p_user_id: string };
        Returns: boolean;
      };
      admin_set_tariff_settings: {
        Args: {
          p_confirm?: boolean;
          p_email: string;
          p_legacy_rule_enabled: boolean;
          p_telegram: string;
        };
        Returns: Json;
      };
      admin_tool_usage: {
        Args: { p_end_date: string; p_start_date: string };
        Returns: {
          category: string;
          label: string;
          total: number;
        }[];
      };
      admin_undo_space_tariff_event: { Args: { p_event: string }; Returns: Json };
      admin_update_space_tariff: {
        Args: {
          p_ends_on: string;
          p_external_ref: string;
          p_extra_seats: number;
          p_id: string;
          p_note: string;
          p_plan: string;
        };
        Returns: Json;
      };
      admin_update_support_goal: {
        Args: {
          p_goal_id: string;
          p_raised_cents: number;
          p_target_cents: number;
          p_title_en: string;
          p_title_uk: string;
        };
        Returns: {
          created_at: string;
          currency: string;
          description_en: string;
          description_uk: string;
          id: string;
          raised_cents: number;
          slug: string;
          status: string;
          target_cents: number;
          title_en: string;
          title_uk: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'support_goals';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      admin_update_support_goal_amount: {
        Args: { p_goal_id: string; p_raised_cents: number };
        Returns: {
          created_at: string;
          currency: string;
          description_en: string;
          description_uk: string;
          id: string;
          raised_cents: number;
          slug: string;
          status: string;
          target_cents: number;
          title_en: string;
          title_uk: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'support_goals';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      analytics_properties_are_safe: { Args: { payload: Json }; Returns: boolean };
      analytics_properties_are_safe_v2: { Args: { payload: Json }; Returns: boolean };
      archive_launch: {
        Args: {
          p_expected_version: string;
          p_key: string;
          p_launch: string;
          p_suppress?: boolean;
          p_team: string;
        };
        Returns: Json;
      };
      archive_launch_dictionary: {
        Args: { p_id: string; p_key: string; p_kind: string; p_team: string };
        Returns: Json;
      };
      assert_team_member: { Args: { p_team: string }; Returns: boolean };
      attach_team_agent_label: {
        Args: { p_agent: string; p_label: string; p_team: string };
        Returns: Json;
      };
      attach_team_task_agent: {
        Args: { p_agent: string; p_task: string; p_team: string };
        Returns: Json;
      };
      attach_team_task_label: {
        Args: { p_label: string; p_task: string; p_team: string };
        Returns: Json;
      };
      attach_team_task_materials: {
        Args: { p_materials: string[]; p_task: string; p_team: string };
        Returns: Json;
      };
      begin_task_upload: {
        Args: { p_request: string; p_task: string; p_team: string };
        Returns: undefined;
      };
      bind_launch_restitch: {
        Args: { p_generation: string; p_operation: string; p_team: string };
        Returns: undefined;
      };
      can_access_team_workspace: { Args: Record<PropertyKey, never>; Returns: boolean };
      cancel_launch_generation: {
        Args: { p_generation: string; p_launch: string; p_request_key: string; p_team: string };
        Returns: Json;
      };
      cancel_launch_request: {
        Args: { p_cancel_key: string; p_key: string; p_launch: string; p_team: string };
        Returns: Json;
      };
      cancel_library_job: {
        Args: {
          p_agent_instance: string;
          p_attempt: string;
          p_lease_token: string;
          p_team: string;
        };
        Returns: boolean;
      };
      cancel_team_catalog_update: { Args: { p_catalog: string; p_team: string }; Returns: boolean };
      cancel_team_folder_sync: {
        Args: { p_request: string; p_team: string };
        Returns: {
          job_state: string;
          request_outcome: string;
        }[];
      };
      cancel_team_operation: {
        Args: { p_operation: string; p_team: string };
        Returns: {
          created_at: string;
          error_code: string;
          id: string;
          kind: string;
          progress: number;
          result_material_id: string;
          retryable: boolean;
          source_material_id: string;
          stage: string;
          state: string;
          team_id: string;
          updated_at: string;
        }[];
      };
      claim_library_job: {
        Args: {
          p_agent_instance: string;
          p_interface_language: string;
          p_sources?: string[];
          p_supported_kinds: string[];
          p_team: string;
        };
        Returns: Json;
      };
      clear_team_agent_balances: {
        Args: { p_team: string };
        Returns: {
          agent_row_id: string;
          balance: number;
        }[];
      };
      clear_team_agent_finance_values: {
        Args: {
          p_date: string;
          p_fields: Json;
          p_intent?: string;
          p_metric: string;
          p_request_id: string;
          p_team: string;
          p_timezone: string;
        };
        Returns: Json;
      };
      clear_team_agent_run_markers: { Args: { p_team: string }; Returns: Json };
      clear_team_agent_runs: { Args: { p_agent: string; p_team: string }; Returns: Json };
      clear_team_agent_topups: {
        Args: { p_team: string };
        Returns: {
          agent_row_id: string;
          topup: number;
        }[];
      };
      consume_team_transfer_grant: {
        Args: { p_purpose: string; p_token_hash: string };
        Returns: {
          actor_id: string;
          destination_folder_id: string;
          grant_id: string;
          material_id: string;
          max_range_bytes: number;
          operation_id: string;
          team_id: string;
          tool_id: string;
        }[];
      };
      copy_launch: {
        Args: {
          p_expected_version: string;
          p_key: string;
          p_revision: string;
          p_source: string;
          p_team: string;
          p_timezone: string;
        };
        Returns: Json;
      };
      copy_team_tasks: { Args: { p_tasks: string[]; p_team: string }; Returns: string[] };
      copy_team_tasks_once: {
        Args: { p_request: string; p_tasks: string[]; p_team: string };
        Returns: string[];
      };
      create_invitation: {
        Args: { p_email: string; p_initial_role: string; p_team: string; p_token_hash: string };
        Returns: {
          delivery_error_code: string;
          delivery_state: string;
          expires_at: string;
          id: string;
          initial_role: string;
          inviter_name: string;
          state: string;
          target_email: string;
          target_user_id: string;
          team_name: string;
        }[];
      };
      create_launch_dictionary: {
        Args: { p_kind: string; p_request_key: string; p_team: string; p_value: string };
        Returns: Json;
      };
      create_team: {
        Args: { p_name: string };
        Returns: {
          connection_state: string;
          id: string;
          name: string;
          permissions: Json;
          role: string;
        }[];
      };
      create_team_account: {
        Args: { p_name: string; p_starts_on?: string; p_team: string; p_timezone?: string };
        Returns: {
          archived_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          lifecycle_version: number;
          name: string;
          sort_rank: number;
          starts_on: string | null;
          team_id: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'team_accounts';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_team_label: {
        Args: { p_color?: string; p_name: string; p_scope?: string; p_team: string };
        Returns: {
          color: string;
          created_at: string;
          created_by: string;
          id: string;
          name: string;
          scope: string;
          team_id: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'team_labels';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_team_task: {
        Args: {
          p_assignee?: string;
          p_initial_material?: string;
          p_note?: string;
          p_team: string;
          p_title: string;
        };
        Returns: {
          assignee_id: string | null;
          assignee_label_snapshot: string | null;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          note: string | null;
          progress_manually_set: boolean;
          progress_max: number;
          progress_value: number;
          status: string;
          task_date: string | null;
          team_id: string;
          title: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'team_tasks';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_two_factor_entry: {
        Args: { p_name: string; p_secret: string };
        Returns: {
          created_at: string;
          id: string;
          name: string;
          secret: string;
          updated_at: string;
        }[];
      };
      create_upload_batch: {
        Args: {
          p_geo: string;
          p_items: Json;
          p_language: string;
          p_language_mode: string;
          p_offer: string;
          p_stage: string;
          p_team: string;
          p_type_hint: string;
        };
        Returns: Json;
      };
      decline_invitation: {
        Args: { p_invitation: string; p_plain_token?: string };
        Returns: boolean;
      };
      delete_draft_team: {
        Args: { p_team: string };
        Returns: {
          ok: boolean;
        }[];
      };
      delete_team_account: {
        Args: { p_account: string; p_team: string };
        Returns: {
          ok: boolean;
        }[];
      };
      delete_team_account_agent: {
        Args: { p_agent: string; p_team: string };
        Returns: {
          ok: boolean;
        }[];
      };
      delete_team_agent_run: { Args: { p_run: string; p_team: string }; Returns: Json };
      delete_team_label: {
        Args: { p_label: string; p_team: string };
        Returns: {
          ok: boolean;
        }[];
      };
      delete_team_task: {
        Args: { p_task: string; p_team: string };
        Returns: {
          ok: boolean;
        }[];
      };
      delete_two_factor_entry: { Args: { p_entry: string }; Returns: undefined };
      detach_task_material_safely: {
        Args: { p_material: string; p_task: string; p_team: string };
        Returns: Json;
      };
      detach_team_agent_label: {
        Args: { p_agent: string; p_label: string; p_team: string };
        Returns: Json;
      };
      detach_team_task_agent: {
        Args: { p_agent: string; p_task: string; p_team: string };
        Returns: Json;
      };
      detach_team_task_label: {
        Args: { p_label: string; p_task: string; p_team: string };
        Returns: Json;
      };
      detach_team_task_material: {
        Args: { p_material: string; p_task: string; p_team: string };
        Returns: boolean;
      };
      draw_restitch_screens: { Args: { p_exclude?: string[]; p_team: string }; Returns: Json };
      edit_launch_dictionary: {
        Args: {
          p_expected_updated_at: string;
          p_id: string;
          p_kind: string;
          p_operation: string;
          p_request_key: string;
          p_team: string;
          p_value: string;
        };
        Returns: Json;
      };
      expire_team_invitations: { Args: Record<PropertyKey, never>; Returns: number };
      fail_library_job: {
        Args: {
          p_agent_instance: string;
          p_attempt: string;
          p_error_code: string;
          p_lease_token: string;
          p_team: string;
        };
        Returns: boolean;
      };
      find_launch_generation: { Args: { p_key: string; p_team: string }; Returns: Json };
      find_reusable_transcript: { Args: { p_team: string; p_video: string }; Returns: Json };
      find_team_folder_sync_request: {
        Args: { p_folder?: string; p_team: string };
        Returns: {
          created_at: string;
          state: string;
          sync_job_id: string;
        }[];
      };
      find_team_folder_sync_request_by_key: {
        Args: { p_request_key: string; p_team: string };
        Returns: {
          request_id: string;
          state: string;
          sync_job_id: string;
        }[];
      };
      get_drive_connection_status: {
        Args: { p_team: string };
        Returns: {
          capabilities_checked_at: string;
          connected_account_email: string;
          connection_id: string;
          drive_kind: string;
          initial_sync_state: string;
          last_error_code: string;
          last_synced_at: string;
          root_folder_id: string;
          root_folder_name: string;
          state: string;
        }[];
      };
      get_effective_restitch_defaults: { Args: { p_team: string }; Returns: Json };
      get_launch_copy_marks: {
        Args: {
          p_team: string;
          p_launch: string;
          p_revision: string;
          p_actor: string;
          p_values: Json;
        };
        Returns: Json;
      };
      set_launch_copy_marks: {
        Args: {
          p_team: string;
          p_launch: string;
          p_revision: string;
          p_actor: string;
          p_values: Json;
          p_copied: boolean;
        };
        Returns: undefined;
      };
      get_launch: {
        Args: { p_launch: string; p_revision?: string; p_team: string };
        Returns: Json;
      };
      get_launch_archive_warning: { Args: { p_launch: string; p_team: string }; Returns: Json };
      get_launch_offer_defaults: { Args: { p_team: string; p_offer: string }; Returns: Json };
      get_launch_defaults: { Args: { p_team: string }; Returns: Json };
      get_launch_restitch_preparation: {
        Args: { p_generation: string; p_team: string };
        Returns: Json;
      };
      get_launch_restitch_reuse: { Args: { p_generation: string; p_team: string }; Returns: Json };
      get_launch_sources: { Args: { p_launch: string; p_team: string }; Returns: Json };
      get_library_processing_context: { Args: { p_source: string; p_team: string }; Returns: Json };
      get_material_preview: {
        Args: { p_material: string; p_team: string };
        Returns: {
          can_download: boolean;
          can_edit: boolean;
          category: string;
          checksum: string;
          drive_file_id: string;
          drive_version: string;
          file_extension: string;
          material_id: string;
          mime_type: string;
          name: string;
          preview_error_code: string;
          preview_state: string;
          resource_key: string;
          size_bytes: number;
          team_id: string;
          transcript_indexed_bytes: number;
          transcript_ingest_state: string;
          transcript_source_version: string;
          transcript_text: string;
          transcript_truncated: boolean;
        }[];
      };
      get_material_product_catalog: {
        Args: { p_team: string; p_video: string };
        Returns: {
          created_at: string;
          drive_file_id: string;
          id: string;
          name: string;
          product_count: number;
          sheet_url: string;
          source_link: string;
        }[];
      };
      get_material_provenance: {
        Args: { p_material: string; p_team: string };
        Returns: {
          created_at: string;
          derivative_lifecycle: string;
          derivative_material_id: string;
          derivative_name: string;
          link_id: string;
          relation: string;
          source_lifecycle: string;
          source_material_id: string;
          source_name: string;
          source_name_snapshot: string;
          tool_contract_version: number;
          tool_id: string;
        }[];
      };
      get_material_restitch_prep: {
        Args: { p_materials: string[]; p_team: string };
        Returns: {
          detected_end_seconds: number;
          detected_start_seconds: number;
          detector_version: number;
          drive_version: string;
          material_id: string;
          prepared_at: string;
          prepared_by: string | null;
          source_profile: Json | null;
          team_id: string;
          unsupported_reason: string | null;
        }[];
        SetofOptions: {
          from: '*';
          to: 'team_material_restitch_prep';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      get_material_transcript_companion: {
        Args: { p_material: string; p_team: string };
        Returns: {
          drive_file_id: string;
          has_text: boolean;
          id: string;
          ingest_state: string;
          name: string;
        }[];
      };
      get_member_restitch_preference: { Args: { p_team: string }; Returns: Json };
      get_my_space_access: { Args: Record<PropertyKey, never>; Returns: Json };
      get_operation: {
        Args: { p_operation: string; p_team: string };
        Returns: {
          created_at: string;
          error_code: string;
          id: string;
          kind: string;
          progress: number;
          result_material_id: string;
          retryable: boolean;
          source_material_id: string;
          stage: string;
          state: string;
          team_id: string;
          updated_at: string;
        }[];
      };
      get_restitch_defaults: {
        Args: { p_team: string };
        Returns: {
          configured: boolean;
          created_at: string;
          custom_final_duration_seconds: number;
          custom_start_duration_ms: number;
          end_enabled: boolean;
          end_image_ids: string[];
          final_duration_mode: string;
          fit_mode: string;
          operation: string;
          source_mode: string;
          start_duration_mode: string;
          start_enabled: boolean;
          start_image_ids: string[];
          team_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'team_restitch_defaults';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      get_share_preference: { Args: { p_team: string }; Returns: Json };
      get_task_progress_max_default: { Args: Record<PropertyKey, never>; Returns: number };
      get_team_account_archive_preflight: {
        Args: { p_entity: string; p_kind: string; p_team: string };
        Returns: Json;
      };
      get_team_account_mutation: { Args: { p_request_id: string; p_team: string }; Returns: Json };
      get_team_accounts_overview: {
        Args: { p_from: string; p_team: string; p_timezone: string; p_to: string };
        Returns: Json;
      };
      get_team_agent_finance: {
        Args: { p_from: string; p_team: string; p_timezone: string; p_to: string };
        Returns: Json;
      };
      get_team_agent_finance_v2: {
        Args: { p_from: string; p_team: string; p_timezone: string; p_to: string };
        Returns: Json;
      };
      get_team_agent_transfer_eligibility: {
        Args: { p_agent: string; p_team: string; p_timezone: string };
        Returns: Json;
      };
      get_team_catalog_updater: { Args: { p_team: string }; Returns: Json };
      get_team_catalog_updater_grow: { Args: { p_team: string }; Returns: boolean };
      get_team_catalog_updater_random_link_variation: {
        Args: { p_team: string };
        Returns: boolean;
      };
      get_team_catalog_updater_refresh_images: { Args: { p_team: string }; Returns: boolean };
      get_team_catalog_updater_refresh_texts: { Args: { p_team: string }; Returns: boolean };
      get_team_catalog_updater_restitch_default: { Args: { p_team: string }; Returns: boolean };
      get_team_folder_resync_status: {
        Args: { p_job: string; p_team: string };
        Returns: {
          status: string;
        }[];
      };
      get_team_folder_sync_status: { Args: { p_job: string; p_team: string }; Returns: Json };
      get_team_landing_source_status: {
        Args: { p_team: string };
        Returns: {
          has_detached_landing_candidates: boolean;
        }[];
      };
      get_team_material_note: { Args: { p_material: string; p_team: string }; Returns: string };
      get_team_product_catalog_settings: {
        Args: { p_team: string };
        Returns: {
          created_at: string;
          description: string | null;
          image_link: string | null;
          price: number;
          price_max: number | null;
          price_min: number | null;
          team_id: string;
          title: string | null;
          updated_at: string;
          updated_by: string | null;
        }[];
        SetofOptions: {
          from: '*';
          to: 'team_product_catalog_settings';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      get_team_storage_health: { Args: { p_team: string }; Returns: Json };
      get_team_storage_health_v2: { Args: { p_team: string }; Returns: Json };
      get_team_tariff: { Args: { p_team: string }; Returns: Json };
      get_team_task: {
        Args: {
          p_attachment_cursor?: number;
          p_attachment_page_size?: number;
          p_task: string;
          p_team: string;
        };
        Returns: Json;
      };
      get_team_task_progress_max_default: { Args: { p_team: string }; Returns: number };
      get_team_vocab_and_facets: { Args: { p_team: string }; Returns: Json };
      get_transcript_delete_pref: { Args: Record<PropertyKey, never>; Returns: string };
      get_upload_batch: { Args: { p_batch: string; p_team: string }; Returns: Json };
      heartbeat_library_job: {
        Args: {
          p_agent_instance: string;
          p_attempt: string;
          p_lease_token: string;
          p_progress: number;
          p_stage: string;
          p_team: string;
        };
        Returns: Json;
      };
      import_team_agent_finance_legacy: {
        Args: {
          p_currency: string;
          p_date: string;
          p_intent?: string;
          p_legacy: string;
          p_metric: string;
          p_request_id: string;
          p_team: string;
          p_timezone: string;
          p_value: string;
        };
        Returns: Json;
      };
      ingest_agent_journal: {
        Args: { p_agent_instance_id: string; p_installation_id: string; p_records: Json };
        Returns: Json;
      };
      ingest_analytics_events: {
        Args: { p_events: Json };
        Returns: {
          accepted: boolean;
          event_id: string;
          reason: string;
        }[];
      };
      is_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      issue_landing_preview_grant: {
        Args: {
          p_actor: string;
          p_id: string;
          p_material: string;
          p_max_range_bytes: number;
          p_reuse_key: string;
          p_team: string;
          p_token_hash: string;
          p_tool: string;
        };
        Returns: {
          expires_at: string;
          grant_id: string;
        }[];
      };
      issue_team_transfer_grant: {
        Args: {
          p_actor: string;
          p_destination: string;
          p_expires_at: string;
          p_material: string;
          p_max_range_bytes: number;
          p_max_uses: number;
          p_operation: string;
          p_purpose: string;
          p_team: string;
          p_token_hash: string;
          p_tool: string;
        };
        Returns: string;
      };
      join_team_workspace_waitlist: {
        Args: { p_channel?: string; p_plan?: string };
        Returns: boolean;
      };
      join_windows_app_waitlist: { Args: Record<PropertyKey, never>; Returns: boolean };
      leave_team: {
        Args: { p_team: string };
        Returns: {
          ok: boolean;
          warning_code: string;
        }[];
      };
      link_transcript_companion: {
        Args: { p_companion: string; p_team: string; p_video: string };
        Returns: Json;
      };
      list_landing_renders: {
        Args: { p_material_ids: string[]; p_preset: string; p_team: string };
        Returns: {
          failure_reason: string;
          fingerprint: string;
          material_id: string;
          preset: string;
          render_state: string;
          segment_count: number;
          source_checksum: string;
          source_version: string;
          valid: boolean;
        }[];
      };
      list_launch_assignees: {
        Args: { p_team: string };
        Returns: {
          display_name: string;
          user_id: string;
        }[];
      };
      list_launch_dictionaries: { Args: { p_team: string }; Returns: Json };
      list_launch_revisions: {
        Args: { p_before?: number; p_launch: string; p_team: string };
        Returns: Json;
      };
      list_launches: { Args: { p_filter?: Json; p_limit?: number; p_team: string }; Returns: Json };
      list_library_contribution_totals: {
        Args: { p_from?: string; p_team: string; p_to?: string };
        Returns: {
          action_kind: string;
          category: string;
          outcome: string;
          total: number;
        }[];
      };
      list_library_materials: {
        Args: { p_cursor?: string; p_page_size?: number; p_stage: string; p_team: string };
        Returns: {
          category: string;
          created_at: string;
          file_extension: string;
          id: string;
          language: string;
          language_decision_source: string;
          lifecycle: string;
          mime_type: string;
          name: string;
          offer: string;
          placement_state: string;
          size_bytes: number;
          source_version: string;
          stage: string;
          team_id: string;
          thumbnail_state: string;
          thumbnail_time_ms: number;
          type: string;
        }[];
      };
      list_material_product_catalogs: {
        Args: { p_team: string; p_video: string };
        Returns: {
          created_at: string;
          drive_file_id: string;
          id: string;
          name: string;
          product_count: number;
          sheet_url: string;
          source_link: string;
          variant: number;
        }[];
      };
      list_material_tasks: {
        Args: { p_material: string; p_team: string };
        Returns: {
          id: string;
          status: string;
          title: string;
        }[];
      };
      list_my_invitations: {
        Args: Record<PropertyKey, never>;
        Returns: {
          created_at: string;
          delivery_error_code: string;
          delivery_state: string;
          expires_at: string;
          id: string;
          initial_role: string;
          inviter_name: string;
          state: string;
          target_email: string;
          team_id: string;
          team_name: string;
        }[];
      };
      list_my_teams: {
        Args: Record<PropertyKey, never>;
        Returns: {
          connection_state: string;
          id: string;
          name: string;
          permissions: Json;
          role: string;
        }[];
      };
      list_restitch_sources: { Args: { p_scope: string; p_team: string }; Returns: Json };
      list_task_attachment_cleanup: { Args: { p_task: string; p_team: string }; Returns: Json };
      list_task_attachment_folders: {
        Args: { p_task: string; p_team: string };
        Returns: {
          material_id: string;
          parent_folder_id: string;
        }[];
      };
      list_team_account_archive: {
        Args: { p_cursor?: string; p_limit?: number; p_query?: string; p_team: string };
        Returns: Json;
      };
      list_team_account_two_factor_seeds: {
        Args: { p_team: string };
        Returns: {
          account_id: string;
          secret: string;
        }[];
      };
      list_team_accounts: {
        Args: { p_team: string };
        Returns: {
          agents: Json;
          created_at: string;
          id: string;
          name: string;
          task_count: number;
          team_id: string;
          updated_at: string;
        }[];
      };
      list_team_accounts_legacy_038: {
        Args: { p_team: string };
        Returns: {
          agents: Json;
          created_at: string;
          id: string;
          name: string;
          task_count: number;
          team_id: string;
          updated_at: string;
        }[];
      };
      list_team_agent_finance_history: {
        Args: { p_agent: string; p_cursor?: Json; p_limit?: number; p_team: string };
        Returns: Json;
      };
      list_team_agent_finance_legacy: { Args: { p_agent?: string; p_team: string }; Returns: Json };
      list_team_audit_events: {
        Args: { p_before?: string; p_limit?: number; p_team: string };
        Returns: {
          action: string;
          actor_id: string;
          actor_label: string;
          error_code: string;
          id: string;
          occurred_at: string;
          result: string;
          subject_label: string;
          target: Json;
        }[];
      };
      list_team_bulk_trash: { Args: { p_team: string }; Returns: Json };
      list_team_catalog_update_attempts: {
        Args: { p_catalog: string; p_limit?: number; p_team: string };
        Returns: {
          actual_changes: Json;
          attempt_id: string;
          catalog_material_id: string;
          delivery_verified_at: string;
          ended_at: string;
          failure_code: string;
          profile_snapshot: Json;
          profile_version: number;
          result: string;
          source_attempt_id: string;
          stage_history: Json;
          started_at: string;
          trigger_kind: string;
        }[];
      };
      list_team_catalog_update_profiles: {
        Args: { p_team: string };
        Returns: {
          catalog_material_id: string;
          grow_products: boolean;
          last_error_at: string;
          last_result: string;
          last_successful_at: string;
          latest_attempt_at: string;
          random_link_variation: boolean;
          reconciliation_required: boolean;
          refresh_images: boolean;
          refresh_texts: boolean;
          restitch: boolean;
          restitch_blocked_code: string;
          restitch_status: string;
          schedule: Json;
          updated_at: string;
          version: number;
        }[];
      };
      list_team_drive_selections: {
        Args: { p_team: string };
        Returns: {
          drive_folder_id: string;
          id: string;
          is_root: boolean;
          name: string;
          state: string;
        }[];
      };
      list_team_folder_page: {
        Args: {
          p_after_id?: string;
          p_after_sort_key?: string;
          p_kind?: string[];
          p_limit?: number;
          p_parent_folder_id?: string;
          p_team: string;
        };
        Returns: Json;
      };
      list_team_folder_subtree: {
        Args: { p_max_folders?: number; p_root: string; p_team: string };
        Returns: Json;
      };
      list_team_folder_tree: {
        Args: { p_team: string };
        Returns: {
          child_file_count: number;
          child_folder_count: number;
          drive_file_id: string;
          id: string;
          indexed_at: string;
          name: string;
          parent_folder_id: string;
          selection_id: string;
          thumbnail_ready_count: number;
        }[];
      };
      list_team_invitations: {
        Args: { p_team: string };
        Returns: {
          created_at: string;
          delivery_error_code: string;
          delivery_state: string;
          expires_at: string;
          id: string;
          initial_role: string;
          last_sent_at: string;
          state: string;
          target_email: string;
          target_user_id: string;
        }[];
      };
      list_team_labels: {
        Args: { p_scope?: string; p_team: string };
        Returns: {
          color: string;
          created_at: string;
          id: string;
          name: string;
          scope: string;
          team_id: string;
          updated_at: string;
          usage_count: number;
        }[];
      };
      list_team_materials: {
        Args: { p_parent_folder_id?: string; p_team: string };
        Returns: {
          category: string;
          drive_file_id: string;
          file_extension: string;
          id: string;
          kind: string;
          mime_type: string;
          modified_at: string;
          name: string;
          parent_folder_id: string;
          preview_state: string;
          size_bytes: number;
          team_id: string;
        }[];
      };
      list_team_members: {
        Args: { p_team: string };
        Returns: {
          base_role: string;
          display_name: string;
          effective_permissions: Json;
          email: string;
          joined_at: string;
          membership_id: string;
          permission_overrides: Json;
          role: string;
          user_id: string;
        }[];
      };
      list_team_product_catalog_image_sources: {
        Args: { p_team: string };
        Returns: {
          image_count: number;
          kind: string;
          material_id: string;
          name: string;
          pool_size: number;
        }[];
      };
      list_team_product_catalog_pool_names: {
        Args: { p_limit?: number; p_team: string };
        Returns: {
          name: string;
        }[];
      };
      list_team_product_catalog_texts: {
        Args: { p_team: string };
        Returns: {
          description: string;
          id: string;
          sort_order: number;
          title: string;
        }[];
      };
      list_team_product_catalogs: {
        Args: { p_team: string };
        Returns: {
          catalog_id: string;
          created_at: string;
          folder_drive_id: string;
          folder_name: string;
          in_updater: boolean;
          last_update_error: string;
          last_updated_at: string;
          name: string;
          next_run_at: string;
          product_count: number;
          restitch_progress: number;
          restitch_stage: string;
          sheet_url: string;
          update_count: number;
          update_interval: string;
          update_pending: boolean;
          update_stage: string;
          video_id: string;
          video_name: string;
        }[];
      };
      list_team_tasks: {
        Args: {
          p_account?: string;
          p_agent?: string;
          p_assignee?: string;
          p_created_from?: string;
          p_created_to?: string;
          p_cursor?: string;
          p_day_from?: string;
          p_day_to?: string;
          p_labels?: string[];
          p_page_size?: number;
          p_sort?: string;
          p_status?: string;
          p_team: string;
          p_unassigned?: boolean;
        };
        Returns: {
          agents: Json;
          assignee_id: string;
          assignee_label_snapshot: string;
          attachment_count: number;
          completed_at: string;
          created_at: string;
          created_by: string;
          id: string;
          labels: Json;
          note: string;
          progress_manually_set: boolean;
          progress_max: number;
          progress_value: number;
          status: string;
          task_date: string;
          team_id: string;
          title: string;
          updated_at: string;
        }[];
      };
      list_team_trashed_materials: {
        Args: { p_before?: string; p_limit?: number; p_team: string };
        Returns: {
          id: string;
          kind: string;
          name: string;
          parent_path_hint: string;
          trashed_at: string;
        }[];
      };
      list_two_factor_entries: {
        Args: Record<PropertyKey, never>;
        Returns: {
          created_at: string;
          id: string;
          name: string;
          secret: string;
          updated_at: string;
        }[];
      };
      list_video_text_variants: { Args: { p_team: string; p_video: string }; Returns: Json };
      lookup_invitable_account: {
        Args: { p_email: string; p_team: string };
        Returns: {
          confirmed_email: string;
          display_name: string;
          user_id: string;
        }[];
      };
      mark_team_bulk_trash_request: {
        Args: { p_error?: string; p_group: string; p_material: string; p_team: string };
        Returns: undefined;
      };
      move_team_account_agent: {
        Args: {
          p_agent: string;
          p_effective_on: string;
          p_expected_placement_id: string;
          p_expected_placement_version: string;
          p_request_id: string;
          p_target_account: string;
          p_team: string;
          p_timezone: string;
        };
        Returns: Json;
      };
      next_product_catalog_variant: { Args: { p_team: string; p_video: string }; Returns: number };
      owned_team_count: { Args: { p_user: string }; Returns: number };
      patch_team_catalog_update_profile: {
        Args: { p_catalog: string; p_expected_version: number; p_patch: Json; p_team: string };
        Returns: Json;
      };
      pause_launch_restitch: {
        Args: { p_code: string; p_generation: string; p_team: string };
        Returns: undefined;
      };
      prepare_launch_restitch: {
        Args: { p_exclude?: string[]; p_generation: string; p_team: string };
        Returns: Json;
      };
      prepare_launch_restitch_unchecked: {
        Args: { p_exclude?: string[]; p_generation: string; p_team: string };
        Returns: Json;
      };
      prepare_team_bulk_trash_item: {
        Args: { p_group: string; p_material: string; p_team: string };
        Returns: Json;
      };
      read_google_drive_credential: {
        Args: { p_credential: string };
        Returns: {
          connected_by: string;
          credential_id: string;
          google_account_email: string;
          google_permission_id: string;
          refresh_token: string;
          scope: string;
        }[];
      };
      record_material_source_language: {
        Args: { p_language: string; p_material: string; p_team: string };
        Returns: boolean;
      };
      record_team_audit: {
        Args: {
          p_action: string;
          p_actor: string;
          p_error_code?: string;
          p_result: string;
          p_target: Json;
          p_team: string;
        };
        Returns: string;
      };
      remove_member: {
        Args: { p_member: string; p_team: string };
        Returns: {
          ok: boolean;
          warning_code: string;
        }[];
      };
      remove_team_drive_selection: {
        Args: { p_selection: string; p_team: string };
        Returns: undefined;
      };
      rename_team: { Args: { p_name: string; p_team: string }; Returns: string };
      rename_team_account: {
        Args: { p_account: string; p_name: string; p_team: string };
        Returns: {
          archived_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          lifecycle_version: number;
          name: string;
          sort_rank: number;
          starts_on: string | null;
          team_id: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'team_accounts';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      reorder_team_accounts: {
        Args: {
          p_anchor: string;
          p_expected_version: string;
          p_moved: string;
          p_parent: string;
          p_relation: string;
          p_request_id: string;
          p_scope: string;
          p_team: string;
        };
        Returns: Json;
      };
      replace_team_product_catalog_texts: {
        Args: { p_items: Json; p_team: string };
        Returns: number;
      };
      request_landing_render_refresh: {
        Args: { p_material: string; p_team: string };
        Returns: number;
      };
      request_space_owner_nudge: { Args: { p_team: string }; Returns: Json };
      request_team_catalog_resync:
        | {
            Args: { p_team: string };
            Returns: {
              initial_sync_state: string;
              sync_job_id: string;
            }[];
          }
        | {
            Args: { p_request_key: string; p_team: string };
            Returns: {
              initial_sync_state: string;
              outcome: string;
              request_id: string;
              sync_job_id: string;
            }[];
          };
      request_team_folder_resync:
        | {
            Args: { p_folder: string; p_team: string };
            Returns: {
              initial_sync_state: string;
              sync_job_id: string;
            }[];
          }
        | {
            Args: { p_folder: string; p_request_key: string; p_team: string };
            Returns: {
              initial_sync_state: string;
              outcome: string;
              request_id: string;
              sync_job_id: string;
            }[];
          };
      resend_invitation: {
        Args: { p_invitation: string; p_token_hash: string };
        Returns: {
          delivery_error_code: string;
          delivery_state: string;
          expires_at: string;
          id: string;
          initial_role: string;
          inviter_name: string;
          state: string;
          target_email: string;
          team_name: string;
        }[];
      };
      reset_share_preference: { Args: { p_team: string }; Returns: boolean };
      resolve_launch_selection: { Args: { p_config: Json; p_team: string }; Returns: Json };
      resume_team_catalog_updater: { Args: { p_team: string }; Returns: boolean };
      retry_failed_library_jobs: {
        Args: { p_sources?: string[]; p_team: string };
        Returns: number;
      };
      retry_launch_generation: {
        Args: { p_generation: string; p_key: string; p_team: string };
        Returns: Json;
      };
      retry_launch_restitch: {
        Args: { p_generation: string; p_key: string; p_team: string };
        Returns: Json;
      };
      retry_team_catalog_update: {
        Args: { p_catalog: string; p_source_attempt: string; p_team: string };
        Returns: number;
      };
      retry_workspace_recovery: { Args: { p_recovery: string }; Returns: boolean };
      revoke_invitation: { Args: { p_invitation: string }; Returns: boolean };
      retire_team_recovery_installation: { Args: { p_installation: string }; Returns: number };
      revoke_team_recovery: { Args: { p_installation: string; p_team: string }; Returns: boolean };
      run_team_catalog_update_now: {
        Args: { p_catalogs: string[]; p_team: string };
        Returns: number;
      };
      save_launch_draft: {
        Args: {
          p_config: Json;
          p_expected_sources: Json;
          p_expected_version: string;
          p_launch: string;
          p_request_key: string;
          p_team: string;
        };
        Returns: Json;
      };
      save_launch_overrides: {
        Args: {
          p_baseline: string;
          p_expected_version: string;
          p_launch: string;
          p_overrides: Json;
          p_request_key: string;
          p_team: string;
        };
        Returns: Json;
      };
      save_launch_working_copy: {
        Args: {
          p_baseline: string;
          p_config: Json;
          p_expected_sources: Json;
          p_expected_version: string;
          p_launch: string;
          p_overrides: Json;
          p_request_key: string;
          p_team: string;
        };
        Returns: Json;
      };
      save_team_catalog_updater: {
        Args: { p_catalogs: string[]; p_interval: string; p_restitch: boolean; p_team: string };
        Returns: Json;
      };
      scan_library_requirements: {
        Args: {
          p_commit?: boolean;
          p_interface_language: string;
          p_kinds?: string[];
          p_sources?: string[];
          p_team: string;
        };
        Returns: Json;
      };
      search_materials: {
        Args: {
          p_filters?: Json;
          p_kind?: string[];
          p_page?: number;
          p_page_size?: number;
          p_parent_folder_id?: string;
          p_query?: string;
          p_recursive?: boolean;
          p_team: string;
        };
        Returns: Json;
      };
      service_accept_launch_generation: {
        Args: {
          p_actor: string;
          p_config: Json;
          p_digest: string;
          p_expected_version: string;
          p_key: string;
          p_launch: string;
          p_preview: Json;
          p_sources: Json;
          p_team: string;
        };
        Returns: Json;
      };
      service_accept_launch_generation_unfenced: {
        Args: {
          p_actor: string;
          p_config: Json;
          p_digest: string;
          p_expected_version: string;
          p_key: string;
          p_launch: string;
          p_preview: Json;
          p_sources: Json;
          p_team: string;
        };
        Returns: Json;
      };
      service_accept_library_result: {
        Args: {
          p_actor: string;
          p_agent_instance: string;
          p_attempt: string;
          p_lease_token: string;
          p_result_material: string;
          p_source_version: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_ack_launch_upload_quiescence: {
        Args: { p_operation: string; p_token_hash: string };
        Returns: boolean;
      };
      service_append_library_contribution: {
        Args: {
          p_action: string;
          p_actor: string;
          p_agent_instance?: string;
          p_category: string;
          p_outcome: string;
          p_team: string;
        };
        Returns: string;
      };
      service_attach_launch_catalog: {
        Args: {
          p_actor: string;
          p_fence: string;
          p_generation: string;
          p_owner: string;
          p_team: string;
        };
        Returns: undefined;
      };
      service_authorize_catalog_cleanup: {
        Args: { p_kind: string; p_material: string; p_worker: string };
        Returns: boolean;
      };
      service_authorize_launch_cleanup: {
        Args: {
          p_fence: string;
          p_file: string;
          p_generation: string;
          p_intent_fence: string;
          p_owner: string;
          p_team: string;
        };
        Returns: string;
      };
      service_authorize_launch_permission_cleanup: {
        Args: {
          p_credential: string;
          p_fence: string;
          p_file: string;
          p_generation: string;
          p_intent_fence: string;
          p_owner: string;
          p_permission: string;
          p_team: string;
        };
        Returns: string;
      };
      service_authorize_launch_video_cleanup: {
        Args: {
          p_fence: string;
          p_file: string;
          p_generation: string;
          p_operation: string;
          p_owner: string;
          p_team: string;
        };
        Returns: string;
      };
      service_authorize_process_output_cleanup: {
        Args: { p_fence: string; p_operation: string; p_owner: string };
        Returns: boolean;
      };
      service_authorize_task_cleanup: { Args: { p_id: string }; Returns: boolean };
      service_begin_catalog_folder: {
        Args: {
          p_epoch: number;
          p_folder: string;
          p_job: string;
          p_restart?: boolean;
          p_worker: string;
        };
        Returns: {
          generation: string;
          page_token: string;
        }[];
      };
      service_begin_catalog_intent: {
        Args: {
          p_actor: string;
          p_key: string;
          p_owner: string;
          p_payload: Json;
          p_team: string;
          p_video: string;
        };
        Returns: Json;
      };
      service_begin_catalog_update_write: {
        Args: {
          p_baseline_version: string;
          p_expected_count: number;
          p_item: string;
          p_marker: string;
          p_product_count: number;
          p_settings_snapshot: Json;
          p_swapped_copy: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      service_begin_change_replay: {
        Args: { p_connection: string; p_job: string };
        Returns: boolean;
      };
      service_begin_process_output_trash: {
        Args: { p_fence: string; p_operation: string; p_owner: string };
        Returns: boolean;
      };
      service_begin_team_recovery_execution: {
        Args: { p_hash: string; p_input: Json };
        Returns: Json;
      };
      service_bind_drive_credential: {
        Args: { p_actor: string; p_credential: string; p_team: string };
        Returns: boolean;
      };
      service_bind_restitch_job_operation: {
        Args: { p_job: string; p_lease_token_hash: string; p_operation: string };
        Returns: boolean;
      };
      service_bind_team_operation_source: {
        Args: {
          p_actor: string;
          p_checksum: string;
          p_drive_file_id: string;
          p_drive_version: string;
          p_operation: string;
        };
        Returns: boolean;
      };
      service_bootstrap_catalog_sync: {
        Args: { p_epoch: number; p_job: string; p_token: string; p_worker: string };
        Returns: boolean;
      };
      service_catalog_missing_candidates: {
        Args: { p_epoch: number; p_generation: string; p_job: string; p_worker: string };
        Returns: {
          expected_revision: number;
          file_id: string;
        }[];
      };
      service_catalog_scan_frontier: {
        Args: { p_epoch: number; p_job: string; p_worker: string };
        Returns: {
          folder_id: string;
          generation: string;
          state: string;
        }[];
      };
      service_catalog_sync_lease_live: {
        Args: { p_epoch: number; p_job: string; p_worker: string };
        Returns: boolean;
      };
      service_checkpoint_catalog_intent: {
        Args: {
          p_actor: string;
          p_checkpoint: Json;
          p_fence: string;
          p_intent: string;
          p_operation?: string;
          p_owner: string;
          p_result?: Json;
          p_state: string;
          p_team: string;
        };
        Returns: undefined;
      };
      service_checkpoint_catalog_sync_job: {
        Args: {
          p_change_token: string;
          p_discovered_folders?: Json;
          p_folder_queue: Json;
          p_job: string;
          p_page_token: string;
          p_phase: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      service_checkpoint_initial_sync: {
        Args: { p_folder_queue: Json; p_job: string; p_page_token: string; p_worker: string };
        Returns: boolean;
      };
      service_checkpoint_material_group_intent: {
        Args: { p_intent: string; p_material: string };
        Returns: boolean;
      };
      service_claim_archive_inspections: {
        Args: { p_limit?: number };
        Returns: {
          checksum: string;
          credential_id: string;
          drive_file_id: string;
          drive_version: string;
          material_id: string;
          resource_key: string;
          size_bytes: number;
          team_id: string;
        }[];
      };
      service_claim_catalog_reconciliations: {
        Args: { p_limit?: number };
        Returns: {
          baseline_version: string;
          catalog_material_id: string;
          credential_id: string;
          drive_file_id: string;
          marker: string;
          resource_key: string;
        }[];
      };
      service_claim_catalog_sync_jobs: {
        Args: { p_lease_seconds?: number; p_limit?: number; p_worker: string };
        Returns: {
          attempts: number;
          connection_id: string;
          credential_id: string;
          cursor: Json;
          drive_id: string;
          drive_kind: string;
          folder_queue: Json;
          job_id: string;
          phase: string;
          root_folder_id: string;
          root_resource_key: string;
          team_id: string;
        }[];
      };
      service_claim_catalog_sync_work: {
        Args: { p_lease_seconds?: number; p_limit?: number; p_worker: string };
        Returns: {
          attempts: number;
          bootstrap_required: boolean;
          connection_id: string;
          credential_id: string;
          cursor: Json;
          drive_id: string;
          drive_kind: string;
          folder_queue: Json;
          job_id: string;
          job_kind: string;
          lease_epoch: number;
          phase: string;
          root_folder_id: string;
          root_resource_key: string;
          team_id: string;
        }[];
      };
      service_claim_catalog_updater_items: {
        Args: { p_lease_seconds?: number; p_limit?: number; p_worker: string };
        Returns: {
          attempts: number;
          catalog_material_id: string;
          credential_id: string;
          current_video_link: string;
          drive_file_id: string;
          grow_products: boolean;
          price_max: number;
          price_min: number;
          product_count: number;
          random_link_variation: boolean;
          refresh_images: boolean;
          refresh_texts: boolean;
          resource_key: string;
          settings_snapshot: Json;
          source_link: string;
          spare_link: string;
          spare_material_id: string;
          team_id: string;
          update_count: number;
          video_link: string;
        }[];
      };
      service_claim_launch_cleanup: { Args: { p_limit?: number; p_owner: string }; Returns: Json };
      service_claim_launch_generation: {
        Args: { p_actor: string; p_generation: string; p_owner: string; p_team: string };
        Returns: Json;
      };
      service_claim_launch_video_cleanup: {
        Args: { p_limit?: number; p_owner: string };
        Returns: Json;
      };
      service_claim_orphan_cleanups: {
        Args: { p_lease_seconds?: number; p_limit?: number; p_worker: string };
        Returns: {
          companion_kind: string;
          credential_id: string;
          drive_file_id: string;
          material_id: string;
          name: string;
          resource_key: string;
          team_id: string;
        }[];
      };
      service_claim_preview_warm: {
        Args: { p_limit?: number };
        Returns: {
          connection_id: string;
          credential_id: string;
          drive_file_id: string;
          drive_version: string;
          material_id: string;
          mime_type: string;
          resource_key: string;
          team_id: string;
        }[];
      };
      service_claim_process_output_cleanup: {
        Args: { p_limit?: number; p_owner: string };
        Returns: Json;
      };
      service_claim_restitch_job: {
        Args: {
          p_actor: string;
          p_lease_seconds?: number;
          p_lease_token_hash: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_claim_retired_restitch_copies: {
        Args: { p_limit?: number };
        Returns: {
          credential_id: string;
          drive_file_id: string;
          material_id: string;
          team_id: string;
        }[];
      };
      service_claim_tariff_notices: { Args: { p_limit?: number }; Returns: Json };
      service_claim_task_cleanup: { Args: { p_limit?: number }; Returns: Json };
      service_claim_upload_folder: {
        Args: { p_actor: string; p_key: string; p_name: string; p_parent: string; p_team: string };
        Returns: {
          claimed: boolean;
          operation_id: string;
          result_material_id: string;
          state: string;
        }[];
      };
      service_clone_material_extras: {
        Args: { p_copy: string; p_source: string; p_team: string };
        Returns: Json;
      };
      service_commit_archive_inspection: {
        Args: { p_fingerprint?: string; p_material: string; p_outcome: string; p_version: string };
        Returns: boolean;
      };
      service_commit_catalog_scan_page: {
        Args: {
          p_complete: boolean;
          p_epoch: number;
          p_expected_page_token: string;
          p_files: Json;
          p_generation: string;
          p_job: string;
          p_next_page_token: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      service_commit_catalog_transcript: {
        Args: {
          p_error_code?: string;
          p_expected_checksum: string;
          p_expected_extension: string;
          p_expected_mime_type: string;
          p_expected_version: string;
          p_indexed_bytes: number;
          p_material: string;
          p_state: string;
          p_text: string;
        };
        Returns: boolean;
      };
      service_commit_landing_preview_validation: {
        Args: {
          p_actor: string;
          p_expected_checksum: string;
          p_expected_version: string;
          p_fingerprint: string;
          p_material: string;
          p_team: string;
        };
        Returns: boolean;
      };
      service_commit_landing_render: {
        Args: {
          p_artifact_root: string;
          p_fingerprint: string;
          p_render: string;
          p_segment_count: number;
        };
        Returns: string;
      };
      service_commit_library_folder: {
        Args: {
          p_connection: string;
          p_drive_folder_id: string;
          p_parent_folder_id: string;
          p_resource_key: string;
          p_segment: string;
          p_team: string;
          p_value: string;
        };
        Returns: {
          drive_folder_id: string;
          material_id: string;
          parent_folder_id: string;
          resource_key: string;
          segment: string;
          value: string;
        }[];
      };
      service_commit_task_drop_folder: {
        Args: {
          p_connection: string;
          p_drive_folder_id: string;
          p_name: string;
          p_parent_folder_id: string;
          p_resource_key: string;
          p_team: string;
        };
        Returns: {
          material_id: string;
        }[];
      };
      service_commit_team_material_mutation: {
        Args: { p_actor: string; p_drive: Json; p_operation: string };
        Returns: Json;
      };
      service_commit_team_text_edit: {
        Args: {
          p_actor: string;
          p_expected_checksum: string;
          p_expected_version: string;
          p_new_checksum: string;
          p_new_version: string;
          p_operation: string;
          p_size_bytes: number;
          p_text: string;
        };
        Returns: Json;
      };
      service_commit_thumbnail: {
        Args: { p_material: string; p_reason?: string; p_state: string; p_version?: string };
        Returns: string;
      };
      service_commit_workspace_folder: {
        Args: { p_drive_folder_id: string; p_marker: string; p_team: string };
        Returns: boolean;
      };
      service_complete_catalog_sync_job:
        | {
            Args: {
              p_change_token: string;
              p_job: string;
              p_next_phase?: string;
              p_worker: string;
            };
            Returns: boolean;
          }
        | {
            Args: {
              p_change_token: string;
              p_epoch: number;
              p_job: string;
              p_next_phase?: string;
              p_worker: string;
            };
            Returns: boolean;
          };
      service_complete_catalog_update: {
        Args: {
          p_item: string;
          p_product_count?: number;
          p_settings_snapshot?: Json;
          p_swapped_copy?: string;
          p_update_count: number;
          p_worker: string;
        };
        Returns: boolean;
      };
      service_complete_material_group_intent: { Args: { p_intent: string }; Returns: Json };
      service_complete_orphan_cleanup: {
        Args: { p_material: string; p_trashed: boolean; p_worker: string };
        Returns: boolean;
      };
      service_complete_restitch_job: {
        Args: {
          p_actor: string;
          p_error: string;
          p_job: string;
          p_lease_token_hash: string;
          p_outcome: string;
        };
        Returns: boolean;
      };
      service_confirm_drive_connection: {
        Args: {
          p_actor: string;
          p_capabilities: Json;
          p_credential: string;
          p_drive_id: string;
          p_drive_kind: string;
          p_root_folder_id: string;
          p_root_folder_name: string;
          p_team: string;
        };
        Returns: {
          connection_id: string;
          initial_sync_state: string;
          state: string;
          sync_job_id: string;
        }[];
      };
      service_consume_drive_oauth_transaction: {
        Args: { p_state_hash: string };
        Returns: {
          actor_id: string;
          credential_id: string;
          pkce_verifier: string;
          request_origin: string;
          team_id: string;
        }[];
      };
      service_create_drive_oauth_transaction: {
        Args: {
          p_actor: string;
          p_expires_at: string;
          p_pkce_verifier: string;
          p_request_origin: string;
          p_state_hash: string;
          p_team: string;
        };
        Returns: boolean;
      };
      service_create_folder_lifecycle_intent: {
        Args: {
          p_action: string;
          p_actor: string;
          p_destination_parent_id?: string;
          p_material: string;
          p_operation: string;
          p_team: string;
        };
        Returns: {
          action: string;
          applied_member_ids: string[];
          intent_id: string;
          members: Json;
          operation_id: string;
          source_material_id: string;
          team_id: string;
        }[];
      };
      service_create_material_group_intent: {
        Args: {
          p_actor: string;
          p_destination_material: string;
          p_destination_parent_id: string;
          p_expected_revision: number;
          p_language: string;
          p_material: string;
          p_offer: string;
          p_operation: string;
          p_stage: string;
          p_team: string;
          p_type: string;
        };
        Returns: {
          action: string;
          applied_member_ids: string[];
          intent_id: string;
          members: Json;
          operation_id: string;
          source_material_id: string;
          team_id: string;
        }[];
      };
      service_create_material_lifecycle_intent: {
        Args: {
          p_action: string;
          p_actor: string;
          p_destination_parent_id?: string;
          p_material: string;
          p_operation: string;
          p_team: string;
        };
        Returns: {
          action: string;
          applied_member_ids: string[];
          intent_id: string;
          members: Json;
          operation_id: string;
          source_material_id: string;
          team_id: string;
        }[];
      };
      service_defer_restitch_job: {
        Args: { p_code: string; p_interval: string; p_job: string; p_lease_token_hash: string };
        Returns: boolean;
      };
      service_delete_google_drive_credential: { Args: { p_credential: string }; Returns: boolean };
      service_detach_drive_connection: {
        Args: { p_actor: string; p_connection: string; p_team: string };
        Returns: {
          credential_id: string;
          delete_credential: boolean;
          detached: boolean;
        }[];
      };
      service_direct_add_registered_member: {
        Args: { p_actor: string; p_base_role: string; p_email: string; p_team: string };
        Returns: {
          base_role: string;
          display_name: string;
          effective_permissions: Json;
          email: string;
          joined_at: string;
          membership_id: string;
          permission_overrides: Json;
          role: string;
          user_id: string;
        }[];
      };
      service_draw_product_catalog_images: {
        Args: { p_count: number; p_team: string };
        Returns: {
          drive_file_id: string;
          material_id: string;
          name: string;
          resource_key: string;
        }[];
      };
      service_draw_product_catalog_texts: {
        Args: { p_count: number; p_team: string };
        Returns: {
          description: string;
          title: string;
        }[];
      };
      service_draw_restitch_screens: {
        Args: { p_actor: string; p_exclude?: string[]; p_team: string };
        Returns: Json;
      };
      service_enqueue_catalog_reconciliation:
        | { Args: { p_connection: string }; Returns: string }
        | {
            Args: { p_connection: string; p_epoch: number; p_job: string; p_worker: string };
            Returns: string;
          };
      service_enqueue_discovered_catalog_subtree: {
        Args: {
          p_epoch: number;
          p_folder: string;
          p_job: string;
          p_parent: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      service_enqueue_material_enrichments: {
        Args: { p_material: string; p_source_version: string; p_team: string };
        Returns: number;
      };
      service_fail_landing_render: {
        Args: { p_reason: string; p_render: string };
        Returns: undefined;
      };
      service_fail_upload_batch_item: {
        Args: {
          p_actor: string;
          p_batch: string;
          p_client_item_key: string;
          p_error_code: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_finalize_upload_batch_item: {
        Args: {
          p_actor: string;
          p_batch: string;
          p_client_item_key: string;
          p_material: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_finalize_uploaded_material: {
        Args: { p_actor: string; p_drive: Json; p_operation: string };
        Returns: Json;
      };
      service_find_team_name_conflicts: {
        Args: {
          p_actor: string;
          p_destination_folder: string;
          p_reserved_name_key: string;
          p_team: string;
        };
        Returns: {
          drive_file_id: string;
          material_id: string;
          name: string;
        }[];
      };
      service_find_team_name_conflicts_in_folder: {
        Args: {
          p_actor: string;
          p_drive_folder_id: string;
          p_reserved_name_key: string;
          p_team: string;
        };
        Returns: {
          drive_file_id: string;
          material_id: string;
          name: string;
        }[];
      };
      service_find_transcript_by_fingerprint: {
        Args: { p_fingerprint: string; p_team: string };
        Returns: {
          source_checksum: string;
          source_version: string;
          transcript_text: string;
        }[];
      };
      service_finish_catalog_folder: {
        Args: { p_epoch: number; p_generation: string; p_job: string; p_worker: string };
        Returns: boolean;
      };
      service_finish_catalog_update_write: { Args: { p_item: string }; Returns: boolean };
      service_finish_launch_cleanup: {
        Args: {
          p_cleaned_file?: string;
          p_fence: string;
          p_generation: string;
          p_intent_fence: string;
          p_owner: string;
          p_team: string;
        };
        Returns: string;
      };
      service_finish_launch_video_cleanup: {
        Args: {
          p_cleaned_file?: string;
          p_fence: string;
          p_generation: string;
          p_operation: string;
          p_owner: string;
          p_team: string;
        };
        Returns: string;
      };
      service_finish_tariff_notice: {
        Args: { p_error?: string; p_id: string; p_sent: boolean; p_skipped?: boolean };
        Returns: boolean;
      };
      service_forget_restitch_copy: {
        Args: { p_deleted: boolean; p_material: string };
        Returns: boolean;
      };
      service_get_drive_connection_credential: {
        Args: { p_actor: string; p_team: string };
        Returns: {
          connection_id: string;
          credential_id: string;
          drive_id: string;
          drive_kind: string;
          google_account_email: string;
          root_folder_id: string;
          root_resource_key: string;
          state: string;
        }[];
      };
      service_get_drive_credential_reference: {
        Args: { p_actor: string; p_team: string };
        Returns: {
          credential_id: string;
          google_account_email: string;
        }[];
      };
      service_get_effective_restitch_defaults: {
        Args: { p_actor: string; p_team: string };
        Returns: Json;
      };
      service_get_landing_render_artifact: {
        Args: { p_material: string; p_preset: string; p_team: string };
        Returns: {
          artifact_root: string;
          fingerprint: string;
          preset: string;
          render_id: string;
          segment_count: number;
          source_version: string;
        }[];
      };
      service_get_landing_render_artifact_by_id: {
        Args: { p_material: string; p_render: string; p_team: string };
        Returns: {
          artifact_root: string;
          fingerprint: string;
          preset: string;
          render_id: string;
          segment_count: number;
          source_version: string;
        }[];
      };
      service_get_landing_render_upload: {
        Args: { p_material: string; p_render: string; p_team: string };
        Returns: {
          preset: string;
          render_id: string;
          rendered_by: string;
          source_checksum: string;
          source_version: string;
        }[];
      };
      service_get_library_asset_placement: {
        Args: { p_actor: string; p_material: string; p_team: string };
        Returns: {
          language: string;
          material_id: string;
          offer: string;
          placement_revision: number;
          stage: string;
          type: string;
        }[];
      };
      service_get_library_connection_context: {
        Args: { p_actor: string; p_team: string };
        Returns: {
          connection_id: string;
          credential_id: string;
          drive_id: string;
          drive_kind: string;
          root_folder_id: string;
          root_resource_key: string;
        }[];
      };
      service_get_material_operation_context: {
        Args: {
          p_actor: string;
          p_allow_trashed?: boolean;
          p_material: string;
          p_permission: string;
          p_team: string;
        };
        Returns: {
          actor_id: string;
          category: string;
          checksum: string;
          connection_id: string;
          credential_id: string;
          drive_file_id: string;
          drive_id: string;
          drive_version: string;
          file_extension: string;
          kind: string;
          lifecycle: string;
          material_id: string;
          mime_type: string;
          name: string;
          parent_folder_id: string;
          resource_key: string;
          root_folder_id: string;
          root_resource_key: string;
          size_bytes: number;
          team_id: string;
          transcript_ingest_state: string;
          transcript_truncated: boolean;
        }[];
      };
      service_get_material_transfer_context: {
        Args: { p_actor: string; p_material: string; p_team: string };
        Returns: {
          actor_id: string;
          category: string;
          checksum: string;
          connection_id: string;
          credential_id: string;
          drive_file_id: string;
          drive_id: string;
          drive_version: string;
          material_id: string;
          mime_type: string;
          name: string;
          resource_key: string;
          root_folder_id: string;
          root_resource_key: string;
          size_bytes: number;
          team_id: string;
        }[];
      };
      service_get_process_upload: { Args: { p_actor: string; p_operation: string }; Returns: Json };
      service_get_root_operation_context: {
        Args: { p_actor: string; p_permission: string; p_team: string };
        Returns: {
          actor_id: string;
          connection_id: string;
          credential_id: string;
          drive_id: string;
          root_folder_id: string;
          root_resource_key: string;
          team_id: string;
        }[];
      };
      service_get_space_restitch_defaults: { Args: { p_team: string }; Returns: Json };
      service_get_team_operation: {
        Args: { p_actor: string; p_operation: string };
        Returns: {
          actor_id: string;
          destination_folder_id: string;
          expected_name: string;
          expected_size: number;
          kind: string;
          mime_type: string;
          operation_id: string;
          progress: number;
          provider_result_id: string;
          relation: string;
          replace_material_id: string;
          result_material_id: string;
          source_material_id: string;
          stage: string;
          state: string;
          team_id: string;
          tool_contract_version: number;
          tool_id: string;
          version_of_material_id: string;
        }[];
      };
      service_get_team_operation_source_binding: {
        Args: { p_actor: string; p_operation: string };
        Returns: {
          checksum: string;
          drive_file_id: string;
          drive_version: string;
        }[];
      };
      service_get_team_product_catalog_settings: {
        Args: { p_team: string };
        Returns: {
          created_at: string;
          description: string | null;
          image_link: string | null;
          price: number;
          price_max: number | null;
          price_min: number | null;
          team_id: string;
          title: string | null;
          updated_at: string;
          updated_by: string | null;
        }[];
        SetofOptions: {
          from: '*';
          to: 'team_product_catalog_settings';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      service_get_workspace_folder: {
        Args: { p_team: string };
        Returns: {
          drive_folder_id: string;
          marker: string;
        }[];
      };
      service_heartbeat_restitch_job: {
        Args: {
          p_actor: string;
          p_job: string;
          p_lease_seconds?: number;
          p_lease_token_hash: string;
        };
        Returns: boolean;
      };
      service_interrupt_launch_generation: {
        Args: {
          p_actor: string;
          p_code: string;
          p_fence: string;
          p_generation: string;
          p_owner: string;
          p_team: string;
        };
        Returns: undefined;
      };
      service_invalidate_landing_renders:
        | {
            Args: { p_connection: string; p_drive_file_ids: string[] };
            Returns: {
              artifact_root: string;
              material_id: string;
              team_id: string;
            }[];
          }
        | {
            Args: {
              p_connection: string;
              p_drive_file_ids: string[];
              p_epoch: number;
              p_job: string;
              p_worker: string;
            };
            Returns: {
              artifact_root: string;
              material_id: string;
              team_id: string;
            }[];
          };
      service_is_launch_restitch_process: {
        Args: { p_actor: string; p_operation: string };
        Returns: boolean;
      };
      service_launch_restitch_receipt: {
        Args: {
          p_actor: string;
          p_fence: string;
          p_generation: string;
          p_owner: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_launch_sources: {
        Args: { p_actor: string; p_launch: string; p_team: string };
        Returns: Json;
      };
      service_launch_worker_ready: { Args: Record<PropertyKey, never>; Returns: boolean };
      service_link_launch_restitch_catalog: {
        Args: {
          p_actor: string;
          p_companion: string;
          p_fence: string;
          p_generation: string;
          p_owner: string;
          p_record: Json;
          p_team: string;
        };
        Returns: Json;
      };
      service_link_product_catalog_companion: {
        Args: {
          p_companion: string;
          p_record: Json;
          p_replaces: string;
          p_team: string;
          p_video: string;
        };
        Returns: Json;
      };
      service_link_restitched_product_catalog_companion: {
        Args: {
          p_companion: string;
          p_record: Json;
          p_replaces: string;
          p_team: string;
          p_video: string;
        };
        Returns: Json;
      };
      service_link_transcript_companion: {
        Args: {
          p_companion: string;
          p_fingerprint: string;
          p_team: string;
          p_text: string;
          p_video: string;
        };
        Returns: Json;
      };
      service_list_connection_selections: {
        Args: { p_connection: string };
        Returns: {
          drive_folder_id: string;
          id: string;
          is_root: boolean;
          resource_key: string;
        }[];
      };
      service_list_launch_catalog_recovery: { Args: { p_limit?: number }; Returns: Json };
      service_list_launch_cleanup_permissions: {
        Args: {
          p_fence: string;
          p_generation: string;
          p_intent_fence: string;
          p_owner: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_list_pending_catalog_transcripts: {
        Args: { p_connection: string; p_file_ids: Json };
        Returns: {
          checksum: string;
          drive_file_id: string;
          drive_version: string;
          file_extension: string;
          material_id: string;
          mime_type: string;
          resource_key: string;
        }[];
      };
      service_list_user_restitch_objects: { Args: { p_user: string }; Returns: string[] };
      service_mark_catalog_update_unknown: {
        Args: { p_error: string; p_item: string; p_worker: string };
        Returns: boolean;
      };
      service_mark_drive_needs_reauth: { Args: { p_credential: string }; Returns: number };
      service_mark_folder_indexed:
        | { Args: { p_connection: string; p_drive_folder_id: string }; Returns: number }
        | {
            Args: {
              p_connection: string;
              p_drive_folder_id: string;
              p_epoch: number;
              p_job: string;
              p_worker: string;
            };
            Returns: number;
          };
      service_mark_landing_renders_stale: {
        Args: { p_material: string; p_team: string };
        Returns: number;
      };
      service_mark_launch_permission_cleaned: {
        Args: {
          p_credential: string;
          p_fence: string;
          p_file: string;
          p_generation: string;
          p_intent_fence: string;
          p_owner: string;
          p_permission: string;
          p_team: string;
        };
        Returns: undefined;
      };
      service_mark_launch_permission_retained: {
        Args: {
          p_credential: string;
          p_fence: string;
          p_file: string;
          p_generation: string;
          p_intent_fence: string;
          p_owner: string;
          p_permission: string;
          p_team: string;
        };
        Returns: undefined;
      };
      service_mark_material_group_reconciling: {
        Args: { p_error_code: string; p_intent: string };
        Returns: boolean;
      };
      service_mark_root_state:
        | {
            Args: { p_connection: string; p_root_name?: string; p_state: string };
            Returns: undefined;
          }
        | {
            Args: {
              p_connection: string;
              p_epoch: number;
              p_job: string;
              p_root_name?: string;
              p_state: string;
              p_worker: string;
            };
            Returns: undefined;
          };
      service_next_product_catalog_variant: {
        Args: { p_team: string; p_video: string };
        Returns: number;
      };
      service_note_restitched_folder: {
        Args: { p_drive_folder_id: string; p_team: string };
        Returns: undefined;
      };
      service_open_catalog_updater_rounds: { Args: Record<PropertyKey, never>; Returns: number };
      service_peek_drive_oauth_transaction: {
        Args: { p_state_hash: string };
        Returns: {
          actor_id: string;
          credential_id: string;
          request_origin: string;
          team_id: string;
        }[];
      };
      service_plan_catalog_resources: {
        Args: {
          p_actor: string;
          p_fence: string;
          p_intent: string;
          p_owner: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_prepare_launch_process_upload: {
        Args: { p_actor: string; p_operation: string };
        Returns: boolean;
      };
      service_prepare_process_upload: {
        Args: {
          p_actor: string;
          p_checksum: string;
          p_connection: string;
          p_file: string;
          p_operation: string;
        };
        Returns: Json;
      };
      service_publish_launch_generation: {
        Args: { p_actor: string; p_fence: string; p_generation: string; p_team: string };
        Returns: Json;
      };
      service_reconcile_catalog_result: {
        Args: { p_actor: string; p_intent: string; p_team: string };
        Returns: Json;
      };
      service_record_access_expiry: {
        Args: { p_credential: string; p_expires_at: string; p_scope_set?: string[] };
        Returns: number;
      };
      service_record_catalog_permission: {
        Args: {
          p_actor: string;
          p_credential: string;
          p_fence: string;
          p_file: string;
          p_intent: string;
          p_owner: string;
          p_permission: string;
          p_prior_anyone: boolean;
          p_state: string;
          p_team: string;
        };
        Returns: undefined;
      };
      service_record_catalog_update_changes: {
        Args: { p_changes: Json; p_item: string; p_worker: string };
        Returns: boolean;
      };
      service_record_restitch_output: {
        Args: {
          p_drive_file_id: string;
          p_material: string;
          p_operation: string;
          p_shared_link: string;
        };
        Returns: string;
      };
      service_recovery_claim_restitch: {
        Args: {
          p_actor: string;
          p_hash: string;
          p_lease_seconds: number;
          p_lease_token_hash: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_refresh_material_revision: {
        Args: {
          p_checksum: string;
          p_drive_file_id: string;
          p_drive_version: string;
          p_material: string;
        };
        Returns: boolean;
      };
      service_release_catalog_sync_job:
        | { Args: { p_job: string; p_worker: string }; Returns: boolean }
        | { Args: { p_epoch: number; p_job: string; p_worker: string }; Returns: boolean };
      service_release_team_name_reservation: { Args: { p_operation: string }; Returns: boolean };
      service_replace_drive_connection: {
        Args: {
          p_actor: string;
          p_capabilities: Json;
          p_credential: string;
          p_drive_id: string;
          p_drive_kind: string;
          p_root_folder_id: string;
          p_root_folder_name: string;
          p_team: string;
        };
        Returns: {
          connection_id: string;
          initial_sync_state: string;
          state: string;
          sync_job_id: string;
        }[];
      };
      service_report_restitch_job_progress: {
        Args: {
          p_actor: string;
          p_job: string;
          p_lease_token_hash: string;
          p_progress: number;
          p_stage: string;
        };
        Returns: boolean;
      };
      service_request_catalog_rescan: {
        Args: { p_actor: string; p_team: string };
        Returns: string;
      };
      service_requeue_catalog_transcripts: {
        Args: { p_connection: string; p_files: Json };
        Returns: number;
      };
      service_reserve_library_folder: {
        Args: {
          p_connection: string;
          p_parent_folder_id: string;
          p_segment: string;
          p_team: string;
          p_value: string;
        };
        Returns: {
          drive_folder_id: string;
          material_id: string;
          parent_folder_id: string;
          resource_key: string;
          segment: string;
          value: string;
        }[];
      };
      service_resolve_catalog_candidate: {
        Args: {
          p_epoch: number;
          p_expected_revision: number;
          p_file?: Json;
          p_file_id: string;
          p_generation: string;
          p_job: string;
          p_outcome: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      service_resolve_catalog_reconciliation: {
        Args: { p_item: string; p_marker: string; p_outcome: string; p_worker: string };
        Returns: boolean;
      };
      service_resolve_team_folder: {
        Args: { p_actor: string; p_drive_folder_id: string; p_permission: string; p_team: string };
        Returns: {
          drive_file_id: string;
          material_id: string;
          resource_key: string;
        }[];
      };
      service_restitch_screen_context: {
        Args: { p_actor: string; p_material: string; p_team: string };
        Returns: {
          checksum: string;
          drive_file_id: string;
          material_id: string;
          mime_type: string;
          size_bytes: number;
        }[];
      };
      service_restore_registered_launch_catalog: {
        Args: {
          p_actor: string;
          p_fence: string;
          p_generation: string;
          p_owner: string;
          p_team: string;
        };
        Returns: boolean;
      };
      service_retry_catalog_child: {
        Args: {
          p_actor: string;
          p_fence: string;
          p_intent: string;
          p_owner: string;
          p_team: string;
        };
        Returns: number;
      };
      service_retry_catalog_sync_job:
        | {
            Args: {
              p_epoch: number;
              p_error_code: string;
              p_job: string;
              p_next_attempt_at: string;
              p_permanent?: boolean;
              p_worker: string;
            };
            Returns: boolean;
          }
        | {
            Args: {
              p_error_code: string;
              p_job: string;
              p_next_attempt_at: string;
              p_permanent?: boolean;
              p_worker: string;
            };
            Returns: boolean;
          };
      service_retry_catalog_update: {
        Args: { p_error: string; p_item: string; p_next_attempt_at: string; p_worker: string };
        Returns: boolean;
      };
      service_reuse_launch_catalog: {
        Args: {
          p_actor: string;
          p_fence: string;
          p_generation: string;
          p_owner: string;
          p_team: string;
        };
        Returns: boolean;
      };
      service_revoke_user_team_grants: { Args: { p_user: string }; Returns: number };
      service_save_catalog_sync_progress:
        | {
            Args: {
              p_change_token: string;
              p_discovered_folders?: Json;
              p_epoch: number;
              p_folder_queue: Json;
              p_job: string;
              p_page_token: string;
              p_phase: string;
              p_worker: string;
            };
            Returns: boolean;
          }
        | {
            Args: {
              p_change_token: string;
              p_discovered_folders?: Json;
              p_folder_queue: Json;
              p_job: string;
              p_page_token: string;
              p_phase: string;
              p_worker: string;
            };
            Returns: boolean;
          };
      service_set_catalog_update_progress: {
        Args: { p_item: string; p_stage: string; p_worker: string };
        Returns: boolean;
      };
      service_set_team_operation_intent: {
        Args: {
          p_actor: string;
          p_expected_name: string;
          p_expected_size: number;
          p_mime_type: string;
          p_operation: string;
          p_replace_material: string;
          p_tool: string;
          p_tool_contract_version: number;
          p_version_of_material: string;
        };
        Returns: boolean;
      };
      service_settle_launch_authority_losses: { Args: { p_limit?: number }; Returns: number };
      service_settle_launch_batch: { Args: { p_limit?: number }; Returns: Json };
      service_settle_launch_restitch_batch: { Args: { p_limit?: number }; Returns: number };
      service_settle_launch_restitch_cancellations: { Args: { p_limit?: number }; Returns: number };
      service_settle_process_output_cleanup: {
        Args: {
          p_code?: string;
          p_fence: string;
          p_operation: string;
          p_owner: string;
          p_result: string;
        };
        Returns: string;
      };
      service_settle_task_cleanup: { Args: { p_id: string; p_result: string }; Returns: undefined };
      service_start_landing_render: {
        Args: {
          p_actor: string;
          p_material: string;
          p_preset: string;
          p_source_checksum: string;
          p_source_version: string;
          p_team: string;
        };
        Returns: string;
      };
      service_start_launch_process_upload: {
        Args: { p_actor: string; p_operation: string };
        Returns: boolean;
      };
      service_start_process_upload: {
        Args: { p_actor: string; p_operation: string };
        Returns: boolean;
      };
      service_start_team_operation: {
        Args: {
          p_actor: string;
          p_bytes_total: number;
          p_destination_folder: string;
          p_idempotency_key: string;
          p_kind: string;
          p_request_nonce: string;
          p_reservation_expires_at: string;
          p_reserved_name_key: string;
          p_source_material: string;
          p_team: string;
        };
        Returns: {
          operation_id: string;
          reused: boolean;
          state: string;
        }[];
      };
      service_store_google_drive_credential: {
        Args: {
          p_actor: string;
          p_existing_credential?: string;
          p_google_account_email: string;
          p_google_permission_id: string;
          p_refresh_token?: string;
          p_scope: string;
        };
        Returns: string;
      };
      service_team_recovery: {
        Args: { p_action: string; p_hash: string; p_input?: Json };
        Returns: Json;
      };
      service_tombstone_catalog_files:
        | { Args: { p_connection: string; p_items: Json }; Returns: number }
        | {
            Args: {
              p_connection: string;
              p_epoch: number;
              p_items: Json;
              p_job: string;
              p_worker: string;
            };
            Returns: number;
          };
      service_touch_catalog_reconciled:
        | { Args: { p_connection: string }; Returns: undefined }
        | {
            Args: { p_connection: string; p_epoch: number; p_job: string; p_worker: string };
            Returns: undefined;
          };
      service_touch_launch_generation: {
        Args: {
          p_actor: string;
          p_fence: string;
          p_generation: string;
          p_owner: string;
          p_stage: string;
          p_team: string;
        };
        Returns: undefined;
      };
      service_transition_team_operation: {
        Args: {
          p_error_code: string;
          p_operation: string;
          p_progress: number;
          p_result_material: string;
          p_retryable: boolean;
          p_stage: string;
          p_state: string;
        };
        Returns: boolean;
      };
      service_upsert_catalog_page:
        | {
            Args: { p_connection: string; p_files: Json; p_parent_folder_id: string };
            Returns: number;
          }
        | {
            Args: {
              p_connection: string;
              p_epoch: number;
              p_files: Json;
              p_job: string;
              p_parent_folder_id: string;
              p_worker: string;
            };
            Returns: number;
          };
      set_invitation_delivery_state: {
        Args: { p_delivery_state: string; p_error_code?: string; p_invitation: string };
        Returns: boolean;
      };
      set_launch_defaults: {
        Args: {
          p_config: Json;
          p_expected_version: string;
          p_key: string;
          p_sub_config: Json;
          p_team: string;
        };
        Returns: Json;
      };
      set_launch_offer_defaults: {
        Args: {
          p_config: Json;
          p_expected_version: string | null;
          p_key: string;
          p_sub_config: Json;
          p_team: string;
          p_offer: string;
        };
        Returns: Json;
      };
      set_material_restitch_prep: {
        Args: { p_drive_version: string; p_material: string; p_prep: Json };
        Returns: boolean;
      };
      set_member_restitch_defaults: { Args: { p_defaults: Json; p_team: string }; Returns: Json };
      set_member_restitch_sources: {
        Args: { p_items: Json; p_slot: string; p_team: string };
        Returns: Json;
      };
      set_member_restitch_use_owner: {
        Args: { p_team: string; p_use_owner: boolean };
        Returns: Json;
      };
      set_restitch_defaults: {
        Args: { p_defaults: Json; p_team: string };
        Returns: {
          configured: boolean;
          created_at: string;
          custom_final_duration_seconds: number;
          custom_start_duration_ms: number;
          end_enabled: boolean;
          end_image_ids: string[];
          final_duration_mode: string;
          fit_mode: string;
          operation: string;
          source_mode: string;
          start_duration_mode: string;
          start_enabled: boolean;
          start_image_ids: string[];
          team_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'team_restitch_defaults';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_restitch_sources: {
        Args: { p_items: Json; p_slot: string; p_team: string };
        Returns: Json;
      };
      set_share_preference: { Args: { p_allow: boolean; p_team: string }; Returns: boolean };
      set_task_progress_max_default: { Args: { p_value: number }; Returns: undefined };
      set_team_account_archived: {
        Args: {
          p_archived: boolean;
          p_entity: string;
          p_expected_version: string;
          p_kind: string;
          p_preflight_token: string;
          p_request_id: string;
          p_team: string;
        };
        Returns: Json;
      };
      set_team_account_name_color: {
        Args: {
          p_agent: string;
          p_color: number;
          p_expected_version: string;
          p_request_id: string;
          p_team: string;
        };
        Returns: Json;
      };
      set_team_account_two_factor_seed: {
        Args: { p_account: string; p_secret: string; p_team: string };
        Returns: boolean;
      };
      set_team_agent_finance_value:
        | {
            Args: {
              p_agent: string;
              p_date: string;
              p_expected_version: string;
              p_metric: string;
              p_request_id: string;
              p_team: string;
              p_timezone: string;
              p_value: string;
            };
            Returns: Json;
          }
        | {
            Args: {
              p_agent: string;
              p_date: string;
              p_expected_placement_id: string;
              p_expected_version: string;
              p_intent?: string;
              p_metric: string;
              p_request_id: string;
              p_team: string;
              p_timezone: string;
              p_value: string;
            };
            Returns: Json;
          };
      set_team_agent_money: {
        Args: { p_agent: string; p_balance: number; p_team: string; p_topup: number };
        Returns: Json;
      };
      set_team_agent_run_marker: {
        Args: { p_marker: string; p_run: string; p_team: string };
        Returns: Json;
      };
      set_team_catalog_update_interval: {
        Args: { p_catalogs: string[]; p_interval: string; p_team: string };
        Returns: Json;
      };
      set_team_catalog_updater_grow: {
        Args: { p_grow: boolean; p_team: string };
        Returns: boolean;
      };
      set_team_catalog_updater_random_link_variation: {
        Args: { p_enabled: boolean; p_team: string };
        Returns: boolean;
      };
      set_team_catalog_updater_refresh_images: {
        Args: { p_refresh: boolean; p_team: string };
        Returns: boolean;
      };
      set_team_catalog_updater_refresh_texts: {
        Args: { p_refresh: boolean; p_team: string };
        Returns: boolean;
      };
      set_team_catalog_updater_restitch: {
        Args: { p_restitch: boolean; p_team: string };
        Returns: Json;
      };
      set_team_material_tag: {
        Args: { p_color: string; p_material: string; p_team: string };
        Returns: Json;
      };
      set_team_product_catalog_image_sources: {
        Args: { p_items: Json; p_team: string };
        Returns: number;
      };
      set_team_product_catalog_settings: {
        Args: { p_settings: Json; p_team: string };
        Returns: {
          created_at: string;
          description: string | null;
          image_link: string | null;
          price: number;
          price_max: number | null;
          price_min: number | null;
          team_id: string;
          title: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'team_product_catalog_settings';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_team_task_progress_max_default: {
        Args: { p_team: string; p_value: number };
        Returns: number;
      };
      set_transcript_delete_pref: { Args: { p_pref: string }; Returns: string };
      settle_launch_restitch: { Args: { p_generation: string; p_team: string }; Returns: boolean };
      start_team_bulk_trash: {
        Args: { p_group: string; p_materials: string[]; p_team: string };
        Returns: Json;
      };
      stop_team_catalog_updater: { Args: { p_team: string }; Returns: Json };
      team_material_kind: {
        Args: { p_category: string; p_kind: string; p_mime_type: string };
        Returns: string;
      };
      touch_last_seen: { Args: Record<PropertyKey, never>; Returns: string };
      transfer_ownership: {
        Args: { p_demote_to: string; p_team: string; p_to_user: string };
        Returns: {
          connection_state: string;
          id: string;
          name: string;
          permissions: Json;
          role: string;
        }[];
      };
      undo_task_material_detach: { Args: { p_receipt: string; p_team: string }; Returns: Json };
      undo_team_agent_finance_clear: {
        Args: {
          p_intent?: string;
          p_original_request_id: string;
          p_request_id: string;
          p_team: string;
        };
        Returns: Json;
      };
      update_launch_metadata: {
        Args: {
          p_assignee: string;
          p_expected_version: string;
          p_launch: string;
          p_request_key: string;
          p_status: string;
          p_team: string;
        };
        Returns: Json;
      };
      update_material_metadata: {
        Args: { p_material: string; p_patch: Json; p_team: string };
        Returns: Json;
      };
      update_membership: {
        Args: { p_base_role?: string; p_member: string; p_overrides?: Json; p_team: string };
        Returns: {
          base_role: string;
          display_name: string;
          effective_permissions: Json;
          email: string;
          joined_at: string;
          membership_id: string;
          permission_overrides: Json;
          role: string;
          user_id: string;
        }[];
      };
      update_team_account_agent: {
        Args: { p_agent: string; p_agent_id: string; p_team: string };
        Returns: Json;
      };
      update_team_agent_run: {
        Args: { p_note: string; p_run: string; p_team: string };
        Returns: Json;
      };
      update_team_label: {
        Args: { p_color: string; p_label: string; p_name: string; p_team: string };
        Returns: {
          color: string;
          created_at: string;
          created_by: string;
          id: string;
          name: string;
          scope: string;
          team_id: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'team_labels';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_team_product_catalog_text: {
        Args: { p_description: string; p_id: string; p_team: string; p_title: string };
        Returns: {
          description: string;
          id: string;
          position: number;
          team_id: string;
          title: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'team_product_catalog_texts';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_team_task: {
        Args: { p_patch: Json; p_task: string; p_team: string };
        Returns: {
          assignee_id: string | null;
          assignee_label_snapshot: string | null;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          note: string | null;
          progress_manually_set: boolean;
          progress_max: number;
          progress_value: number;
          status: string;
          task_date: string | null;
          team_id: string;
          title: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'team_tasks';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_two_factor_entry: {
        Args: { p_entry: string; p_name: string; p_secret: string };
        Returns: {
          created_at: string;
          id: string;
          name: string;
          secret: string;
          updated_at: string;
        }[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {}
  }
} as const;
