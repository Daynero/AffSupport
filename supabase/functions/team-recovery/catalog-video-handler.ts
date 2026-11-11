import { STITCH_ERROR_CODES } from '../../../packages/shared/dist/stitch-errors.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
export const CATALOG_VARIANT_ACTIONS = [
  'variant_claim',
  'variant_load',
  'variant_save',
  'variant_reconcile',
  'variant_dispatch',
  'variant_process',
  'variant_admit',
  'variant_authorize',
  'variant_heartbeat',
  'variant_complete',
  'variant_enroll'
] as const;
export type CatalogVariantRecoveryAction = (typeof CATALOG_VARIANT_ACTIONS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuid = (v: unknown) => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new TeamFunctionError('INVALID_INPUT');
  return v;
};
export function isCatalogVariantRecoveryAction(
  value: string
): value is CatalogVariantRecoveryAction {
  return (CATALOG_VARIANT_ACTIONS as readonly string[]).includes(value);
}
/** Closed projection only: actor/team/settings and endpoint URLs are never body authority. */
export function parseCatalogVariantRecoveryInput(
  action: CatalogVariantRecoveryAction,
  body: Record<string, unknown>
) {
  if (body.variantProtocolVersion !== 1) throw new TeamFunctionError('AGENT_UPDATE_REQUIRED');
  const nativeInstanceId = uuid(body.nativeInstanceId);
  if (action === 'variant_claim') return { nativeInstanceId, protocolVersion: 1 };
  const setId = uuid(body.setId);
  if (action === 'variant_load') return { setId, nativeInstanceId, protocolVersion: 1 };
  if (action === 'variant_save') {
    const value = body.snapshot;
    if (
      !isRecord(value) ||
      value.setId !== setId ||
      typeof body.expectedRevision !== 'number' ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0 ||
      value.revision !== body.expectedRevision + 1 ||
      !Array.isArray(value.children) ||
      value.children.length < 1 ||
      value.children.length > 400
    )
      throw new TeamFunctionError('INVALID_INPUT');
    const children = value.children.map((c, index) => {
      if (
        !isRecord(c) ||
        c.index !== index ||
        !['queued', 'working', 'unknown', 'registered'].includes(String(c.state))
      )
        throw new TeamFunctionError('INVALID_INPUT');
      return {
        index,
        requestId: uuid(c.requestId),
        operationId: c.operationId === null ? null : uuid(c.operationId),
        state: c.state,
        outputId: c.outputId === null ? null : uuid(c.outputId)
      };
    });
    return {
      setId,
      nativeInstanceId,
      protocolVersion: 1,
      expectedRevision: body.expectedRevision,
      snapshot: { setId, revision: value.revision, children }
    };
  }
  if (
    typeof body.index !== 'number' ||
    !Number.isSafeInteger(body.index) ||
    body.index < 0 ||
    body.index >= 400
  )
    throw new TeamFunctionError('INVALID_INPUT');
  if (action === 'variant_complete') {
    if (
      !['canceled', 'failed'].includes(String(body.outcome)) ||
      typeof body.failureCode !== 'string' ||
      ![
        'PROCESS_CANCELED',
        ...STITCH_ERROR_CODES,
        'RESTITCH_SCREEN_SELECTION_LIMIT',
        'RESTITCH_SCREEN_FETCH_FAILED',
        'RESTITCH_SCREEN_UNAVAILABLE',
        'RESTITCH_SCREEN_UNSUPPORTED',
        'RESTITCH_NO_SCREENS',
        'RESTITCH_INVALID',
        'SOURCE_CHANGED',
        'PERMISSION_DENIED',
        'RESTITCH_SOURCE_FORBIDDEN',
        'UNSUPPORTED_MEDIA',
        'PROCESS_FAILED',
        'TOO_LARGE'
      ].includes(body.failureCode)
    )
      throw new TeamFunctionError('INVALID_INPUT');
    return {
      setId,
      nativeInstanceId,
      protocolVersion: 1,
      child: {
        index: body.index,
        requestId: uuid(body.requestId),
        operationId: uuid(body.operationId)
      },
      outcome: body.outcome,
      failureCode: body.failureCode
    };
  }
  if (action === 'variant_enroll') {
    if (
      !isRecord(body.enrollment) ||
      typeof body.enrollment.proofDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(body.enrollment.proofDigest)
    )
      throw new TeamFunctionError('INVALID_INPUT');
    return {
      setId,
      nativeInstanceId,
      protocolVersion: 1,
      child: {
        index: body.index,
        requestId: uuid(body.requestId),
        operationId: uuid(body.operationId)
      },
      enrollment: {
        enrollmentId: uuid(body.enrollment.enrollmentId),
        proofDigest: body.enrollment.proofDigest
      }
    };
  }
  return {
    setId,
    nativeInstanceId,
    protocolVersion: 1,
    child: {
      index: body.index,
      requestId: uuid(body.requestId),
      operationId:
        body.operationId === null || body.operationId === undefined ? null : uuid(body.operationId)
    },
    ...(action === 'variant_heartbeat' && body.probe === true ? { probe: true } : {})
  };
}
