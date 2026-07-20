export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Profile = Database['public']['Tables']['profiles']['Row'];
export type AnalyticsEventRow = Database['public']['Tables']['analytics_events']['Row'];
export type AdminUserRow = Database['public']['Functions']['admin_list_users']['Returns'][number];
export type MarketingExportRow =
  Database['public']['Functions']['admin_marketing_export']['Returns'][number];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string | null;
          display_name: string | null;
          avatar_url: string | null;
          language: 'en' | 'uk';
          plan: 'free' | 'pro' | 'team';
          account_status: 'active' | 'blocked' | 'deleted';
          marketing_consent: boolean;
          marketing_consent_at: string | null;
          created_at: string;
          updated_at: string;
          last_seen_at: string | null;
          onboarding_completed: boolean;
        };
        Insert: {
          id: string;
          email?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          language?: 'en' | 'uk';
          plan?: 'free' | 'pro' | 'team';
          account_status?: 'active' | 'blocked' | 'deleted';
          marketing_consent?: boolean;
          marketing_consent_at?: string | null;
          created_at?: string;
          updated_at?: string;
          last_seen_at?: string | null;
          onboarding_completed?: boolean;
        };
        Update: {
          email?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          language?: 'en' | 'uk';
          plan?: 'free' | 'pro' | 'team';
          account_status?: 'active' | 'blocked' | 'deleted';
          marketing_consent?: boolean;
          marketing_consent_at?: string | null;
          updated_at?: string;
          last_seen_at?: string | null;
          onboarding_completed?: boolean;
        };
        Relationships: [];
      };
      admin_users: {
        Row: { user_id: string; created_at: string };
        Insert: { user_id: string; created_at?: string };
        Update: never;
        Relationships: [];
      };
      analytics_events: {
        Row: {
          id: number;
          event_id: string;
          event_version: number;
          occurred_at: string;
          session_sequence: number | null;
          user_id: string | null;
          event_name: string;
          session_id: string | null;
          tool: string | null;
          properties: Json;
          app_version: string | null;
          agent_version: string | null;
          locale: string | null;
          platform: string | null;
          created_at: string;
          installation_id: string | null;
          flow_id: string | null;
          run_id: string | null;
          event_source: string | null;
          web_build_id: string | null;
          local_app_version: string | null;
          local_app_build: string | null;
          release_channel: string | null;
          architecture: string | null;
          core_api_version: number | null;
          tool_contracts: Json;
          feature: string | null;
          screen: string | null;
          action: string | null;
          outcome: string | null;
          error_code: string | null;
          error_stage: string | null;
          error_fingerprint: string | null;
        };
        Insert: {
          id?: number;
          user_id: string;
          event_name: string;
          session_id?: string | null;
          tool?: string | null;
          properties?: Json;
          app_version?: string | null;
          agent_version?: string | null;
          locale?: string | null;
          platform?: string | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      is_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      touch_last_seen: { Args: Record<PropertyKey, never>; Returns: string | null };
      ingest_analytics_events: {
        Args: { p_events: Json };
        Returns: { event_id: string; accepted: boolean; reason: string | null }[];
      };
      admin_overview: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: Json;
      };
      admin_daily_activity: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: {
          activity_date: string;
          active_users: number;
          event_count: number;
        }[];
      };
      admin_tool_usage: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: { category: string; label: string; total: number }[];
      };
      admin_agent_versions: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: { agent_version: string; total: number }[];
      };
      admin_list_users: {
        Args: {
          p_search?: string;
          p_marketing_consent?: boolean | null;
          p_account_status?: string | null;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: {
          id: string;
          email: string | null;
          display_name: string | null;
          language: string;
          plan: string;
          account_status: string;
          marketing_consent: boolean;
          marketing_consent_at: string | null;
          created_at: string;
          last_seen_at: string | null;
          total_count: number;
        }[];
      };
      admin_marketing_export: {
        Args: Record<PropertyKey, never>;
        Returns: {
          email: string;
          display_name: string | null;
          language: string;
          marketing_consent_at: string;
        }[];
      };
      admin_set_account_status: {
        Args: { p_user_id: string; p_account_status: string };
        Returns: boolean;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
