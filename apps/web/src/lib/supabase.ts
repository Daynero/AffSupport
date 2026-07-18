import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicConfig } from './config';
import type { Database } from './database.types';

let client: SupabaseClient<Database> | null = null;

export function getSupabaseClient(): SupabaseClient<Database> | null {
  if (!publicConfig.ok) return null;
  if (!client) {
    client = createClient<Database>(
      publicConfig.value.supabaseUrl,
      publicConfig.value.supabasePublishableKey,
      {
        auth: {
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      }
    );
  }
  return client;
}

export function requireSupabaseClient(): SupabaseClient<Database> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('SUPABASE_CONFIGURATION_MISSING');
  return supabase;
}
