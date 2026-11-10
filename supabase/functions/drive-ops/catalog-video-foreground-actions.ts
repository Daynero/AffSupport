import { catalogVideoFunctionBase } from '../_shared/restitch-native.ts';
import { catalogVideoNativeStore } from './catalog-video-native-store.ts';
import { catalogVideoProcessGrants } from './catalog-video-process-grants.ts';
import {
  prepareCatalogVideoRestitchAlias,
  enrollCatalogVideoRestitchControl
} from './catalog-video-restitch-alias.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
export async function executeCatalogForegroundAction(
  service: ServiceRpcClient,
  key: string,
  action: string,
  claimHash: string,
  body: Record<string, unknown>,
  admit: (
    native: { setId: string; nativeInstanceId: string; claimHash: string; protocolVersion: 1 },
    child: { index: number; requestId: string; operationId: string | null }
  ) => Promise<unknown>
) {
  if (typeof body.setId !== 'string' || typeof body.nativeInstanceId !== 'string')
    throw new TeamFunctionError('INVALID_INPUT');
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
  if (action === 'variant_admit') return admit(native, child);
  throw new TeamFunctionError('INVALID_INPUT');
}
