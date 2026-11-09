import type { CatalogVideoPublicationRequest } from './catalog-publication.js';
import type {
  CatalogPublicationTarget,
  CatalogPublicationJobState,
  CatalogActiveVideoDelivery
} from './catalog-publication-lifecycle.js';
/** Client requests are proposals; Edge verifies identity, membership, source
 * binding and trusted time before calling the service-only CAS. */
export interface CatalogPublicationCommand {
  readonly requestId: string;
  readonly catalogId: string;
  readonly expectedRevision: number;
  readonly publication: CatalogVideoPublicationRequest | Readonly<{ mode: 'held' }>;
  readonly target: CatalogPublicationTarget;
}
export interface CatalogPublicationSnapshot {
  readonly catalogId: string;
  readonly dueState?: 'held' | 'future' | 'due' | 'settled' | 'unknown';
  readonly providerCas?: 'unsupported';
  /** Narrow cell writer capability; does not imply provider content CAS. */
  readonly writerMode?: 'video_columns';
  readonly targetObservation?: Readonly<{
    basis: 'indexed';
    state: 'available' | 'preparing' | 'changed' | 'unavailable' | 'unknown';
  }>;
  readonly serverNow: number;
  readonly revision: number;
  readonly mode: 'immediate' | 'scheduled' | 'held';
  readonly dueAt: string | null;
  readonly timeZone: string | null;
  readonly target: CatalogPublicationTarget;
  readonly job: Readonly<{
    id: string;
    state: CatalogPublicationJobState;
    revision: number;
    writerFence: string | null;
    blockedReason?:
      | 'writer_unsupported'
      | 'legacy_adoption_required'
      | 'target_unavailable'
      | 'job_blocked'
      | 'stale_job'
      | 'clock_unavailable'
      | 'invalid_due'
      | null;
  }> | null;
  readonly active: CatalogActiveVideoDelivery | null;
}

import { parseCatalogVideoPublication } from './catalog-publication.js';
import { parseCatalogPublicationTarget } from './catalog-publication-lifecycle.js';
import { isLaunchTimezone } from './launches/naming.js';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
const revision = (v: unknown, min = 1): v is number => Number.isSafeInteger(v) && Number(v) >= min;
const instant = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
export function parseCatalogPublicationCommand(
  raw: unknown,
  serverNow: number
): CatalogPublicationCommand {
  if (
    !record(raw) ||
    !uuid(raw.requestId) ||
    !uuid(raw.catalogId) ||
    !record(raw.publication) ||
    !revision(raw.expectedRevision, 0)
  )
    throw new Error('INVALID_INPUT');
  const publication =
    record(raw.publication) && raw.publication.mode === 'held'
      ? Object.freeze({ mode: 'held' as const })
      : parseCatalogVideoPublication(raw.publication, serverNow);
  return Object.freeze({
    requestId: raw.requestId.toLowerCase(),
    catalogId: raw.catalogId.toLowerCase(),
    expectedRevision: raw.expectedRevision,
    publication,
    target: parseCatalogPublicationTarget(raw.target)
  });
}
/** Old/malformed records stay unavailable; never translate them into immediate publication. */
export function parseCatalogPublicationSnapshot(raw: unknown): CatalogPublicationSnapshot | null {
  try {
    if (
      !record(raw) ||
      !uuid(raw.catalogId) ||
      !revision(raw.revision, 0) ||
      !Number.isSafeInteger(raw.serverNow) ||
      !['immediate', 'scheduled', 'held'].includes(String(raw.mode))
    )
      return null;
    if (
      raw.mode === 'scheduled'
        ? !instant(raw.dueAt) || !isLaunchTimezone(raw.timeZone)
        : raw.dueAt !== null || raw.timeZone !== null
    )
      return null;
    let job: CatalogPublicationSnapshot['job'] = null;
    if (raw.job !== null) {
      const j = raw.job;
      if (
        !record(j) ||
        !uuid(j.id) ||
        j.revision !== raw.revision ||
        ![
          'waiting',
          'preparing',
          'applying',
          'verifying',
          'retry_wait',
          'unknown',
          'blocked',
          'cancel_requested',
          'published',
          'superseded',
          'held'
        ].includes(String(j.state)) ||
        (j.writerFence !== null && !uuid(j.writerFence))
      )
        return null;
      if (
        j.blockedReason !== undefined &&
        j.blockedReason !== null &&
        ![
          'writer_unsupported',
          'legacy_adoption_required',
          'target_unavailable',
          'job_blocked',
          'stale_job',
          'clock_unavailable',
          'invalid_due'
        ].includes(String(j.blockedReason))
      )
        return null;
      job = Object.freeze({
        id: j.id,
        state: j.state as CatalogPublicationJobState,
        revision: raw.revision,
        writerFence: j.writerFence as string | null,
        blockedReason: (j.blockedReason ?? null) as NonNullable<
          CatalogPublicationSnapshot['job']
        >['blockedReason']
      });
    }
    let active: CatalogPublicationSnapshot['active'] = null;
    if (raw.active !== null) {
      const a = raw.active;
      if (
        !record(a) ||
        typeof a.providerRevision !== 'string' ||
        !a.providerRevision ||
        a.providerRevision.length > 1024 ||
        !instant(a.verifiedAt)
      )
        return null;
      active = Object.freeze({
        target: parseCatalogPublicationTarget(a.target),
        providerRevision: a.providerRevision,
        verifiedAt: a.verifiedAt
      });
    }
    if (
      raw.dueState !== undefined &&
      !['held', 'future', 'due', 'settled', 'unknown'].includes(String(raw.dueState))
    )
      return null;
    if (raw.providerCas !== undefined && raw.providerCas !== 'unsupported') return null;
    if (raw.writerMode !== undefined && raw.writerMode !== 'video_columns') return null;
    if (
      raw.targetObservation !== undefined &&
      (!record(raw.targetObservation) ||
        raw.targetObservation.basis !== 'indexed' ||
        !['available', 'preparing', 'changed', 'unavailable', 'unknown'].includes(
          String(raw.targetObservation.state)
        ))
    )
      return null;
    return Object.freeze({
      catalogId: raw.catalogId,
      ...(raw.dueState === undefined
        ? {}
        : { dueState: raw.dueState as NonNullable<CatalogPublicationSnapshot['dueState']> }),
      ...(raw.providerCas === undefined ? {} : { providerCas: 'unsupported' as const }),
      ...(raw.writerMode === undefined ? {} : { writerMode: 'video_columns' as const }),
      ...(raw.targetObservation === undefined
        ? {}
        : {
            targetObservation: Object.freeze({
              basis: 'indexed' as const,
              state: (raw.targetObservation as Record<string, unknown>).state as NonNullable<
                CatalogPublicationSnapshot['targetObservation']
              >['state']
            })
          }),
      serverNow: raw.serverNow as number,
      revision: raw.revision,
      mode: raw.mode as CatalogPublicationSnapshot['mode'],
      dueAt: raw.dueAt as string | null,
      timeZone: raw.timeZone as string | null,
      target: parseCatalogPublicationTarget(raw.target),
      job,
      active
    });
  } catch {
    return null;
  }
}
