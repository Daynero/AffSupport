import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeadersForRequest } from '../_shared/cors.ts';
import {
  TeamFunctionError,
  errorResponse,
  mapUnknownError,
  successResponse
} from '../_shared/errors.ts';
import { deleteAccountWithTeamPreflight } from './handler.ts';

Deno.serve(async request => {
  const cors = corsHeadersForRequest(request);
  if (!cors) {
    return errorResponse(new TeamFunctionError('PERMISSION_DENIED'), {});
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return errorResponse(new TeamFunctionError('INVALID_INPUT', { status: 405 }), cors);
  }

  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) throw new TeamFunctionError('AUTH_REQUIRED');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const jwt = authorization.slice('Bearer '.length);
    const {
      data: { user },
      error: userError
    } = await admin.auth.getUser(jwt);
    if (userError || !user) throw new TeamFunctionError('AUTH_REQUIRED');

    const deleted = await deleteAccountWithTeamPreflight(user.id, {
      ownedTeamCount: async userId => {
        const { data, error } = await admin.rpc('owned_team_count', { p_user: userId });
        if (error || typeof data !== 'number') {
          throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
        }
        return data;
      },
      revokeDeletedUserGrants: async userId => {
        const { data, error } = await admin.rpc('service_revoke_user_team_grants', {
          p_user: userId
        });
        if (error || typeof data !== 'number') {
          throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
        }
      },
      deleteAuthUser: async () => {
        const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
        if (deleteError) {
          throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
        }
      }
    });

    return successResponse(deleted, cors);
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors);
  }
});
