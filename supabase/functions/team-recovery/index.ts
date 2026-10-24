import { TEAM_RECOVERY_PROTOCOL_VERSION } from '../../../packages/shared/dist/team/recovery.js';
import { recoveryTokenHash } from './digest.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { authorizeCaller } from '../_shared/auth.ts';
import { corsPreflight, corsHeadersForRequest } from '../_shared/cors.ts';
import {
  successResponse,
  errorResponse,
  mapUnknownError,
  TeamFunctionError
} from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { handleRecovery } from './handler.ts';

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const cors = corsHeadersForRequest(request);
  if (request.headers.has('origin') && !cors) return new Response(null, { status: 403 });
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !key || !anon) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
    const service = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const hash = recoveryTokenHash;
    const result = await handleRecovery(request, {
      user: async request => (await authorizeCaller(request, service)).userId,
      rpc: async (action, digest, input) => {
        const { data, error } = await service.rpc('service_team_recovery', {
          p_action: action,
          p_hash: digest,
          p_input: { ...input, protocolVersion: TEAM_RECOVERY_PROTOCOL_VERSION }
        });
        if (error)
          throw new TeamFunctionError(
            ([
              'AUTH_REQUIRED',
              'PERMISSION_DENIED',
              'SPACE_BLOCKED',
              'RATE_LIMITED',
              'AGENT_UPDATE_REQUIRED',
              'PROCESS_RESULT_UNCERTAIN'
            ].find(code => error.message.includes(code)) as
              | 'AUTH_REQUIRED'
              | 'PERMISSION_DENIED'
              | 'SPACE_BLOCKED'
              | 'RATE_LIMITED'
              | 'AGENT_UPDATE_REQUIRED'
              | 'PROCESS_RESULT_UNCERTAIN') ?? 'INVALID_RESPONSE'
          );
        return data;
      },
      revoke: async (actor, team, installation) => {
        const jwt = request.headers.get('authorization') ?? '';
        const caller = createClient(url, anon, {
          global: { headers: { authorization: jwt } },
          auth: { persistSession: false, autoRefreshToken: false }
        });
        const { error } = await caller.rpc('revoke_team_recovery', {
          p_team: team,
          p_installation: installation
        });
        if (error || !actor) throw new TeamFunctionError('PERMISSION_DENIED');
      },
      drive: async (action, credential, body) => {
        const response = await fetch(
          `${url.replace(/\/$/u, '')}/functions/v1/drive-ops/updater/${action}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              apikey: anon,
              'x-team-recovery-credential': credential
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000)
          }
        );
        const value: unknown = await response.json();
        if (!response.ok || !isRecord(value) || value.ok !== true)
          throw new TeamFunctionError('DRIVE_UNAVAILABLE');
        return value.value;
      },
      token: () =>
        btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/u, ''),
      hash
    });
    return successResponse(result, cors ?? {});
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors ?? {});
  }
});
