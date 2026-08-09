export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type SupportGoalStatus = 'draft' | 'active' | 'archived';
export type SupportGoalRow = Omit<
  Database['public']['Tables']['support_goals']['Row'],
  'status'
> & { status: SupportGoalStatus };
export type Profile = Omit<
  Database['public']['Tables']['profiles']['Row'],
  'language' | 'plan' | 'account_status'
> & {
  language: 'en' | 'uk';
  plan: 'free' | 'pro' | 'team';
  account_status: 'active' | 'blocked' | 'deleted';
};
export type AnalyticsEventRow = Database['public']['Tables']['analytics_events']['Row'];
export type AdminUserRow = Database['public']['Functions']['admin_list_users']['Returns'][number];
export type MarketingExportRow =
  Database['public']['Functions']['admin_marketing_export']['Returns'][number];

export type Database = {
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string;
          user_id: string;
        };
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
      analytics_events: {
        Row: {
          action: string | null;
          agent_version: string | null;
          app_version: string | null;
          architecture: string | null;
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
          properties: Json;
          release_channel: string | null;
          run_id: string | null;
          screen: string | null;
          session_id: string | null;
          session_sequence: number | null;
          tool: string | null;
          tool_contracts: Json;
          user_id: string | null;
          web_build_id: string | null;
        };
        Insert: {
          action?: string | null;
          agent_version?: string | null;
          app_version?: string | null;
          architecture?: string | null;
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
          properties?: Json;
          release_channel?: string | null;
          run_id?: string | null;
          screen?: string | null;
          session_id?: string | null;
          session_sequence?: number | null;
          tool?: string | null;
          tool_contracts?: Json;
          user_id?: string | null;
          web_build_id?: string | null;
        };
        Update: {
          action?: string | null;
          agent_version?: string | null;
          app_version?: string | null;
          architecture?: string | null;
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
          properties?: Json;
          release_channel?: string | null;
          run_id?: string | null;
          screen?: string | null;
          session_id?: string | null;
          session_sequence?: number | null;
          tool?: string | null;
          tool_contracts?: Json;
          user_id?: string | null;
          web_build_id?: string | null;
        };
        Relationships: [];
      };
      geo_options: {
        Row: {
          code: string;
        };
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
          account_status: 'active' | 'blocked' | 'deleted';
          avatar_url: string | null;
          created_at: string;
          display_name: string | null;
          email: string | null;
          id: string;
          language: 'en' | 'uk';
          last_seen_at: string | null;
          marketing_consent: boolean;
          marketing_consent_at: string | null;
          onboarding_completed: boolean;
          plan: 'free' | 'pro' | 'team';
          updated_at: string;
        };
        Insert: {
          account_status?: 'active' | 'blocked' | 'deleted';
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id: string;
          language?: 'en' | 'uk';
          last_seen_at?: string | null;
          marketing_consent?: boolean;
          marketing_consent_at?: string | null;
          onboarding_completed?: boolean;
          plan?: 'free' | 'pro' | 'team';
          updated_at?: string;
        };
        Update: {
          account_status?: 'active' | 'blocked' | 'deleted';
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          language?: 'en' | 'uk';
          last_seen_at?: string | null;
          marketing_consent?: boolean;
          marketing_consent_at?: string | null;
          onboarding_completed?: boolean;
          plan?: 'free' | 'pro' | 'team';
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
      team_audit_events: {
        Row: {
          action: string;
          actor_id: string;
          actor_label_snapshot: string | null;
          error_code: string | null;
          id: string;
          occurred_at: string;
          result: string;
          target: Json;
          team_id: string;
        };
        Insert: {
          action: string;
          actor_id: string;
          actor_label_snapshot?: string | null;
          error_code?: string | null;
          id?: string;
          occurred_at?: string;
          result: string;
          target?: Json;
          team_id: string;
        };
        Update: {
          action?: string;
          actor_id?: string;
          actor_label_snapshot?: string | null;
          error_code?: string | null;
          id?: string;
          occurred_at?: string;
          result?: string;
          target?: Json;
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
          team_id: string;
        };
        Insert: {
          event_kind: string;
          id?: number;
          material_id?: string | null;
          occurred_at?: string;
          team_id: string;
        };
        Update: {
          event_kind?: string;
          id?: number;
          material_id?: string | null;
          occurred_at?: string;
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
      team_contract_settings: {
        Row: {
          key: string;
          value: Json;
        };
        Insert: {
          key: string;
          value: Json;
        };
        Update: {
          key?: string;
          value?: Json;
        };
        Relationships: [];
      };
      team_drive_connections: {
        Row: {
          capabilities_checked_at: string | null;
          capability_snapshot: Json;
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
          last_synced_at: string | null;
          root_folder_id: string;
          root_folder_name: string;
          root_resource_key: string | null;
          state: string;
          team_id: string;
          updated_at: string;
        };
        Insert: {
          capabilities_checked_at?: string | null;
          capability_snapshot?: Json;
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
          last_synced_at?: string | null;
          root_folder_id: string;
          root_folder_name: string;
          root_resource_key?: string | null;
          state?: string;
          team_id: string;
          updated_at?: string;
        };
        Update: {
          capabilities_checked_at?: string | null;
          capability_snapshot?: Json;
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
          last_synced_at?: string | null;
          root_folder_id?: string;
          root_folder_name?: string;
          root_resource_key?: string | null;
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
      team_error_codes: {
        Row: {
          code: string;
        };
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
      team_materials: {
        Row: {
          category: string | null;
          checksum: string | null;
          classification_source: string;
          classification_version: number;
          connection_id: string;
          created_at: string;
          drive_file_id: string;
          drive_id: string | null;
          drive_version: string | null;
          file_extension: string | null;
          geo: string | null;
          id: string;
          kind: string;
          landing_validation_fingerprint: string | null;
          landing_validation_state: string | null;
          landing_validation_version: string | null;
          language: string | null;
          lifecycle: string;
          mime_type: string | null;
          missing_at: string | null;
          modified_at: string | null;
          name: string;
          offer: string | null;
          parent_folder_id: string | null;
          preview_error_code: string | null;
          preview_state: string;
          resource_key: string | null;
          search_tsv: unknown;
          shortcut_target_id: string | null;
          shortcut_target_resource_key: string | null;
          size_bytes: number | null;
          tags: string[];
          team_id: string;
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
        Insert: {
          category?: string | null;
          checksum?: string | null;
          classification_source?: string;
          classification_version?: number;
          connection_id: string;
          created_at?: string;
          drive_file_id: string;
          drive_id?: string | null;
          drive_version?: string | null;
          file_extension?: string | null;
          geo?: string | null;
          id?: string;
          kind: string;
          landing_validation_fingerprint?: string | null;
          landing_validation_state?: string | null;
          landing_validation_version?: string | null;
          language?: string | null;
          lifecycle?: string;
          mime_type?: string | null;
          missing_at?: string | null;
          modified_at?: string | null;
          name: string;
          offer?: string | null;
          parent_folder_id?: string | null;
          preview_error_code?: string | null;
          preview_state?: string;
          resource_key?: string | null;
          search_tsv?: unknown;
          shortcut_target_id?: string | null;
          shortcut_target_resource_key?: string | null;
          size_bytes?: number | null;
          tags?: string[];
          team_id: string;
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
          category?: string | null;
          checksum?: string | null;
          classification_source?: string;
          classification_version?: number;
          connection_id?: string;
          created_at?: string;
          drive_file_id?: string;
          drive_id?: string | null;
          drive_version?: string | null;
          file_extension?: string | null;
          geo?: string | null;
          id?: string;
          kind?: string;
          landing_validation_fingerprint?: string | null;
          landing_validation_state?: string | null;
          landing_validation_version?: string | null;
          language?: string | null;
          lifecycle?: string;
          mime_type?: string | null;
          missing_at?: string | null;
          modified_at?: string | null;
          name?: string;
          offer?: string | null;
          parent_folder_id?: string | null;
          preview_error_code?: string | null;
          preview_state?: string;
          resource_key?: string | null;
          search_tsv?: unknown;
          shortcut_target_id?: string | null;
          shortcut_target_resource_key?: string | null;
          size_bytes?: number | null;
          tags?: string[];
          team_id?: string;
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
            foreignKeyName: 'team_materials_connection_id_fkey';
            columns: ['connection_id'];
            isOneToOne: false;
            referencedRelation: 'team_drive_connections';
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
            foreignKeyName: 'team_materials_team_id_fkey';
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
          permission_overrides: Json;
          removed_at: string | null;
          status: string;
          team_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          base_role: string;
          created_at?: string;
          id?: string;
          joined_at?: string;
          permission_overrides?: Json;
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
          permission_overrides?: Json;
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
        Insert: {
          permission: string;
        };
        Update: {
          permission?: string;
        };
        Relationships: [];
      };
      team_roles: {
        Row: {
          is_base_role: boolean;
          role: string;
        };
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
      teams: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          owner_id: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          owner_id: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          owner_id?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
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
      admin_active_support_goal: {
        Args: never;
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
      admin_list_team_workspace_waitlist: {
        Args: never;
        Returns: {
          created_at: string;
          email: string;
          user_id: string;
        }[];
      };
      can_access_team_workspace: {
        Args: never;
        Returns: boolean;
      };
      join_team_workspace_waitlist: {
        Args: never;
        Returns: boolean;
      };
      admin_marketing_export: {
        Args: never;
        Returns: {
          display_name: string;
          email: string;
          language: string;
          marketing_consent_at: string;
        }[];
      };
      admin_overview: {
        Args: { p_end_date: string; p_start_date: string };
        Returns: Json;
      };
      admin_set_account_status: {
        Args: { p_account_status: string; p_user_id: string };
        Returns: boolean;
      };
      admin_tool_usage: {
        Args: { p_end_date: string; p_start_date: string };
        Returns: {
          category: string;
          label: string;
          total: number;
        }[];
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
      analytics_properties_are_safe: {
        Args: { payload: Json };
        Returns: boolean;
      };
      analytics_properties_are_safe_v2: {
        Args: { payload: Json };
        Returns: boolean;
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
      create_invitation: {
        Args: {
          p_email: string;
          p_initial_role: string;
          p_team: string;
          p_token_hash: string;
        };
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
      decline_invitation: {
        Args: { p_invitation: string; p_plain_token?: string };
        Returns: boolean;
      };
      expire_team_invitations: { Args: never; Returns: number };
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
          root_folder_name: string;
          state: string;
        }[];
      };
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
      get_team_vocab_and_facets: { Args: { p_team: string }; Returns: Json };
      ingest_analytics_events: {
        Args: { p_events: Json };
        Returns: {
          accepted: boolean;
          event_id: string;
          reason: string;
        }[];
      };
      is_admin: { Args: never; Returns: boolean };
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
      list_my_invitations: {
        Args: never;
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
        Args: never;
        Returns: {
          connection_state: string;
          id: string;
          name: string;
          permissions: Json;
          role: string;
        }[];
      };
      list_team_audit_events: {
        Args: { p_before?: string; p_limit?: number; p_team: string };
        Returns: {
          action: string;
          actor_label: string;
          error_code: string;
          id: string;
          occurred_at: string;
          result: string;
          target: Json;
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
      lookup_invitable_account: {
        Args: { p_email: string; p_team: string };
        Returns: {
          confirmed_email: string;
          display_name: string;
          user_id: string;
        }[];
      };
      owned_team_count: { Args: { p_user: string }; Returns: number };
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
      revoke_invitation: { Args: { p_invitation: string }; Returns: boolean };
      search_materials: {
        Args: {
          p_filters?: Json;
          p_page?: number;
          p_page_size?: number;
          p_query?: string;
          p_team: string;
        };
        Returns: Json;
      };
      service_begin_change_replay: {
        Args: { p_connection: string; p_job: string };
        Returns: boolean;
      };
      service_bind_drive_credential: {
        Args: { p_actor: string; p_credential: string; p_team: string };
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
        Args: {
          p_folder_queue: Json;
          p_job: string;
          p_page_token: string;
          p_worker: string;
        };
        Returns: boolean;
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
      service_complete_catalog_sync_job: {
        Args: {
          p_change_token: string;
          p_job: string;
          p_next_phase?: string;
          p_worker: string;
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
      service_delete_google_drive_credential: {
        Args: { p_credential: string };
        Returns: boolean;
      };
      service_detach_drive_connection: {
        Args: { p_actor: string; p_connection: string; p_team: string };
        Returns: {
          credential_id: string;
          delete_credential: boolean;
          detached: boolean;
        }[];
      };
      service_direct_add_registered_member: {
        Args: {
          p_actor: string;
          p_base_role: string;
          p_email: string;
          p_team: string;
        };
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
      service_enqueue_catalog_reconciliation: {
        Args: { p_connection: string };
        Returns: string;
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
      service_mark_drive_needs_reauth: {
        Args: { p_credential: string };
        Returns: number;
      };
      service_peek_drive_oauth_transaction: {
        Args: { p_state_hash: string };
        Returns: {
          actor_id: string;
          credential_id: string;
          request_origin: string;
          team_id: string;
        }[];
      };
      service_release_team_name_reservation: {
        Args: { p_operation: string };
        Returns: boolean;
      };
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
      service_requeue_catalog_transcripts: {
        Args: { p_connection: string; p_files: Json };
        Returns: number;
      };
      service_resolve_team_folder: {
        Args: {
          p_actor: string;
          p_drive_folder_id: string;
          p_permission: string;
          p_team: string;
        };
        Returns: {
          drive_file_id: string;
          material_id: string;
          resource_key: string;
        }[];
      };
      service_retry_catalog_sync_job: {
        Args: {
          p_error_code: string;
          p_job: string;
          p_next_attempt_at: string;
          p_permanent?: boolean;
          p_worker: string;
        };
        Returns: boolean;
      };
      service_revoke_user_team_grants: {
        Args: { p_user: string };
        Returns: number;
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
      service_tombstone_catalog_files: {
        Args: { p_connection: string; p_items: Json };
        Returns: number;
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
      service_upsert_catalog_page: {
        Args: {
          p_connection: string;
          p_files: Json;
          p_parent_folder_id: string;
        };
        Returns: number;
      };
      set_invitation_delivery_state: {
        Args: {
          p_delivery_state: string;
          p_error_code?: string;
          p_invitation: string;
        };
        Returns: boolean;
      };
      touch_last_seen: { Args: never; Returns: string };
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
      update_material_metadata: {
        Args: { p_material: string; p_patch: Json; p_team: string };
        Returns: Json;
      };
      update_membership: {
        Args: {
          p_base_role?: string;
          p_member: string;
          p_overrides?: Json;
          p_team: string;
        };
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
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {}
  }
} as const;
