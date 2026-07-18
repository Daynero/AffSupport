import { createClient } from 'npm:@supabase/supabase-js@2';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function corsHeaders(origin: string | null) {
  const configuredOrigin = Deno.env.get('WISHLY_SITE_URL')?.replace(/\/$/, '');
  const allowed = new Set(
    [configuredOrigin, 'http://127.0.0.1:5173', 'http://localhost:5173'].filter(Boolean)
  );
  if (!origin || !allowed.has(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'Origin'
  };
}

function response(status: number, body: Record<string, unknown>, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, ...cors } });
}

Deno.serve(async request => {
  const cors = corsHeaders(request.headers.get('origin'));
  if (!cors) return new Response('Origin not allowed.', { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, cors);

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer '))
    return response(401, { error: 'Authentication required.' }, cors);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey)
    return response(503, { error: 'Account deletion is not configured.' }, cors);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const jwt = authorization.slice('Bearer '.length);
  const {
    data: { user },
    error: userError
  } = await admin.auth.getUser(jwt);
  if (userError || !user) return response(401, { error: 'Session is no longer valid.' }, cors);

  // The authenticated JWT subject is the only deletion target. profiles is
  // removed by ON DELETE CASCADE; analytics_events is anonymized by SET NULL.
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
  if (deleteError) return response(500, { error: 'Account could not be deleted.' }, cors);

  return response(200, { deleted: true }, cors);
});
