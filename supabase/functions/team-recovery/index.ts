import {
  prepareCatalogVideoRestitchAlias,
  enrollCatalogVideoRestitchControl
} from '../drive-ops/catalog-video-restitch-alias.ts';
import { catalogVideoFunctionBase, nativeRestitchEnabled } from '../_shared/restitch-native.ts';
import { catalogVideoNativeStore } from '../drive-ops/catalog-video-native-store.ts';
import { catalogVideoProcessGrants } from '../drive-ops/catalog-video-process-grants.ts';
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
      variants: nativeRestitchEnabled({
        enabled: Deno.env.get('SOTY_CATALOG_VIDEO_VARIANTS'),
        environment: Deno.env.get('SOTY_ENVIRONMENT'),
        oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
        siteUrl: Deno.env.get('WISHLY_SITE_URL')
      })
        ? async (action, claimHash, body, credential) => {
            if (typeof body.nativeInstanceId !== 'string')
              throw new TeamFunctionError('INVALID_INPUT');
            if (action === 'variant_claim') {
              const result = await service.rpc('service_claim_catalog_video_set', {
                p_hash: claimHash,
                p_native: body.nativeInstanceId,
                p_protocol: 1
              });
              if (
                result.error ||
                !isRecord(result.data) ||
                !(result.data.setId === null || typeof result.data.setId === 'string')
              )
                throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
              return { setId: result.data.setId };
            }
            if (typeof body.setId !== 'string') throw new TeamFunctionError('INVALID_INPUT');
            const audience = await service.rpc('service_require_catalog_video_audience', {
              p_set: body.setId,
              p_hash: claimHash,
              p_kind: 'recovery',
              p_enrollment: null
            });
            if (audience.error) throw new TeamFunctionError('AUTH_REQUIRED');
            const native = {
              setId: body.setId,
              nativeInstanceId: body.nativeInstanceId,
              claimHash,
              protocolVersion: 1 as const
            };
            const store = catalogVideoNativeStore(service, native);
            if (action === 'variant_load') return store.load();
            if (action === 'variant_save') {
              if (
                typeof body.expectedRevision !== 'number' ||
                !isRecord(body.snapshot) ||
                body.snapshot.setId !== body.setId ||
                typeof body.snapshot.revision !== 'number' ||
                !Array.isArray(body.snapshot.children)
              )
                throw new TeamFunctionError('INVALID_INPUT');
              return {
                saved: await store.save(body.expectedRevision, {
                  setId: body.setId,
                  revision: body.snapshot.revision,
                  children: body.snapshot.children
                })
              };
            }
            if (
              !isRecord(body.child) ||
              typeof body.child.index !== 'number' ||
              typeof body.child.requestId !== 'string' ||
              !(body.child.operationId === null || typeof body.child.operationId === 'string')
            )
              throw new TeamFunctionError('INVALID_INPUT');
            const child = {
              index: body.child.index,
              requestId: body.child.requestId,
              operationId: body.child.operationId as string | null
            };
            if (action === 'variant_enroll') {
              if (
                !child.operationId ||
                !isRecord(body.enrollment) ||
                typeof body.enrollment.enrollmentId !== 'string' ||
                typeof body.enrollment.proofDigest !== 'string'
              )
                throw new TeamFunctionError('INVALID_INPUT');
              const context = await store.processContext(child);
              return enrollCatalogVideoRestitchControl(
                service,
                key,
                native,
                {
                  ...child,
                  operationId: child.operationId,
                  teamId: context.teamId,
                  actorId: context.actorId,
                  materialId: context.materialId,
                  sourceVersion: context.sourceVersion,
                  settingsDigest: context.settingsDigest
                },
                {
                  rootOperationId: child.operationId,
                  teamId: context.teamId,
                  actorId: context.actorId,
                  nativeInstanceId: native.nativeInstanceId,
                  enrollmentId: body.enrollment.enrollmentId,
                  proofDigest: body.enrollment.proofDigest
                }
              );
            }
            if (action === 'variant_authorize') {
              await store.processContext(child);
              return { authorized: true };
            }
            if (action === 'variant_complete') {
              if (
                (body.outcome !== 'canceled' && body.outcome !== 'failed') ||
                typeof body.failureCode !== 'string'
              )
                throw new TeamFunctionError('INVALID_INPUT');
              return store.complete(child, body.outcome, body.failureCode);
            }
            if (action === 'variant_heartbeat') return store.heartbeat(child);
            if (action === 'variant_reconcile') return store.reconcile(child);
            if (action === 'variant_dispatch')
              return {
                executionAllowed: await store.dispatch(child),
                operationId: child.operationId,
                requestId: child.requestId
              };
            if (action === 'variant_process')
              return catalogVideoProcessGrants(service, native, {
                functionBase: catalogVideoFunctionBase(Deno.env.get('SOTY_ENVIRONMENT')),
                secret: key,
                prepareAlias: async (context, originalChild) => {
                  if (!originalChild.operationId) throw new TeamFunctionError('INVALID_INPUT');
                  const alias = await prepareCatalogVideoRestitchAlias(service, native, {
                    ...originalChild,
                    operationId: originalChild.operationId,
                    teamId: context.teamId,
                    actorId: context.actorId,
                    materialId: context.materialId,
                    sourceVersion: context.sourceVersion,
                    settingsDigest: context.settingsDigest
                  });
                  return {
                    rootOperationId: alias.operationId,
                    selectionProtocol: 1 as const,
                    defaults: alias.recipe.defaults
                  };
                }
              })(child);
            if (action === 'variant_admit') {
              const response = await fetch(
                url.replace(/\/$/u, '') + '/functions/v1/drive-ops/updater/variant_admit',
                {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    apikey: anon,
                    'x-team-recovery-credential': credential
                  },
                  body: JSON.stringify({
                    setId: native.setId,
                    nativeInstanceId: native.nativeInstanceId,
                    protocolVersion: 1,
                    index: child.index,
                    requestId: child.requestId
                  }),
                  redirect: 'error',
                  signal: AbortSignal.timeout(10000)
                }
              );
              const result: unknown = await response.json();
              if (
                !response.ok ||
                !isRecord(result) ||
                result.ok !== true ||
                !isRecord(result.value)
              )
                throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
              return result.value;
            }
            throw new TeamFunctionError('INVALID_INPUT');
          }
        : undefined,
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
