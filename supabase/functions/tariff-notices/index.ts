import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendEmail } from '../_shared/email.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { handleTariffNoticesRequest } from './handler.ts';

/**
 * Tariff letters (feature 034). A thin wrapper: the environment and the service client go in,
 * everything that decides anything lives in `handler.ts` where the tests reach it.
 */

interface RpcFailure {
  code?: string;
  message?: string;
}
interface RpcClient {
  rpc: (
    name: string,
    parameters: Record<string, unknown>
  ) => Promise<{ data: unknown; error: RpcFailure | null }>;
}

function serviceClient(): RpcClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: true });
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  }) as unknown as RpcClient;
}

async function rpcValue(client: RpcClient, name: string, parameters: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: true });
  return data;
}

Deno.serve(request => {
  let service: RpcClient | null = null;
  const client = () => (service ??= serviceClient());
  return handleTariffNoticesRequest(request, {
    secret: Deno.env.get('CATALOG_SYNC_SECRET'),
    environment: Deno.env.get('SOTY_ENVIRONMENT') === 'beta' ? 'beta' : 'production',
    siteUrl: Deno.env.get('WISHLY_SITE_URL') ?? 'http://127.0.0.1:5173',
    sender: {
      apiKey: Deno.env.get('RESEND_API_KEY') ?? '',
      from: Deno.env.get('INVITE_EMAIL_FROM') ?? ''
    },
    claim: async limit => {
      const rows = await rpcValue(client(), 'service_claim_tariff_notices', { p_limit: limit });
      return Array.isArray(rows) ? rows : [];
    },
    finish: async (id, sent, error, skipped) =>
      (await rpcValue(client(), 'service_finish_tariff_notice', {
        p_id: id,
        p_sent: sent,
        p_error: error,
        p_skipped: skipped
      })) === true,
    send: input => sendEmail(input),
    now: () => Date.now(),
    log: (message, detail) => console.error(message, JSON.stringify(detail))
  });
});
