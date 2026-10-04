import { createClient } from 'npm:@supabase/supabase-js@2';
import { authorizeCaller } from '../_shared/auth.ts';
import { corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import { executeFinanceExport } from './handler.ts';
import { financeExportErrorResponse } from './response.ts';

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const cors = corsHeadersForRequest(request);
  if (request.headers.has('origin') && !cors) return new Response(null, { status: 403 });
  const headers = {
    ...cors,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  };
  try {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers });
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !key) throw new Error('FINANCE_EXPORT_FAILED');
    const client = createClient(url, key, {
      global: { headers: { Authorization: request.headers.get('authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    await authorizeCaller(request, client);
    const result = await executeFinanceExport(await request.json(), client);
    return new Response(result.bytes, {
      headers: {
        ...headers,
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${result.filename}"`
      }
    });
  } catch (cause) {
    return financeExportErrorResponse(cause, headers);
  }
});
