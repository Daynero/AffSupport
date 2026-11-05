import type { CatalogUpdateProfile, CatalogUpdateProfilePatch } from '@video-compressor/shared';
import { TeamApiError } from '../../api/team';
import { withReadDeadline } from '../readCoordinator';
import { profilePatchMatches } from './profilePatchMatches';
import type { CatalogSnapshot } from './useCatalogInlineChanges';

export type CatalogSaveOutcome =
  | { kind: 'confirmed'; snapshot: CatalogSnapshot }
  | { kind: 'rejected'; error: TeamApiError }
  | { kind: 'conflict' | 'unknown'; snapshot?: CatalogSnapshot; error: unknown };

/** Bound waiting for a reply, without implying that an accepted write was cancelled. */
function writeAcknowledgement(
  write: () => Promise<CatalogUpdateProfile>,
  signal?: AbortSignal
): Promise<CatalogUpdateProfile> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (success: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (success) resolve(value as CatalogUpdateProfile);
      else reject(value);
    };
    const abort = () => finish(false, new DOMException('Catalog scope changed', 'AbortError'));
    const timer = setTimeout(
      () => finish(false, new TeamApiError('PROCESS_RESULT_UNCERTAIN', true)),
      15_000
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      // Both handlers remain attached: a late reply cannot create an unhandled rejection.
      write().then(
        profile => finish(true, profile),
        error => finish(false, error)
      );
    } catch (error) {
      finish(false, error);
    }
  });
}

/** A lost reply is read back before another write; a rejected CAS is never confirmed by coincidence. */
export async function saveCatalogProfile(input: {
  base: CatalogSnapshot;
  patch: CatalogUpdateProfilePatch;
  write?: () => Promise<CatalogUpdateProfile>;
  read?: (signal: AbortSignal) => Promise<CatalogSnapshot>;
  readOnly?: boolean;
  signal?: AbortSignal;
  canContinue?: () => boolean;
  onStage?: (stage: 'readback_requested' | 'conflict') => void;
}): Promise<CatalogSaveOutcome> {
  const active = () => !input.signal?.aborted && (input.canContinue?.() ?? true);
  const stage = (value: 'readback_requested' | 'conflict') => {
    try {
      input.onStage?.(value);
    } catch {
      /* Diagnostics cannot change a settings write. */
    }
  };
  const unknown = (error: unknown): CatalogSaveOutcome => ({ kind: 'unknown', error });
  const readback = async (error: unknown, conflict = false): Promise<CatalogSaveOutcome> => {
    if (!active()) return unknown(new DOMException('Catalog scope changed', 'AbortError'));
    stage(conflict ? 'conflict' : 'readback_requested');
    if (!input.read) return conflict ? { kind: 'conflict', error } : unknown(error);
    try {
      const latest = await withReadDeadline(
        input.read,
        input.signal ?? new AbortController().signal
      );
      if (!active()) return unknown(new DOMException('Catalog scope changed', 'AbortError'));
      if (latest.profile.catalogId !== input.base.profile.catalogId)
        return unknown(new TeamApiError('INVALID_RESPONSE', false));
      if (conflict) return { kind: 'conflict', snapshot: latest, error };
      if (
        latest.profile.version === input.base.profile.version + 1 &&
        profilePatchMatches(latest, input.patch)
      )
        return { kind: 'confirmed', snapshot: latest };
      if (latest.profile.version > input.base.profile.version)
        return {
          kind: 'conflict',
          snapshot: latest,
          error: new TeamApiError('STALE_RESULT', false)
        };
      return { kind: 'unknown', snapshot: latest, error };
    } catch (cause) {
      return conflict ? { kind: 'conflict', error } : unknown(cause);
    }
  };
  if (!active()) return unknown(new DOMException('Catalog scope changed', 'AbortError'));
  if (input.readOnly) return readback(new TeamApiError('PROCESS_RESULT_UNCERTAIN', true));
  if (!input.write) return { kind: 'rejected', error: new TeamApiError('INVALID_RESPONSE', false) };
  try {
    const profile = await writeAcknowledgement(input.write, input.signal);
    if (!active()) return unknown(new DOMException('Catalog scope changed', 'AbortError'));
    const snapshot = { ...input.base, profile, runtimeObservedAt: undefined };
    if (
      profile.catalogId === input.base.profile.catalogId &&
      profile.version === input.base.profile.version + 1 &&
      input.patch.updateInterval === undefined &&
      input.patch.schedule === undefined &&
      profilePatchMatches(snapshot, input.patch)
    )
      return { kind: 'confirmed', snapshot };
    return readback(new TeamApiError('INVALID_RESPONSE', false));
  } catch (cause) {
    const conflict = cause instanceof TeamApiError && cause.code === 'STALE_RESULT';
    if (
      cause instanceof TeamApiError &&
      !conflict &&
      !cause.retryable &&
      cause.code !== 'INVALID_RESPONSE'
    )
      return { kind: 'rejected', error: cause };
    return readback(cause, conflict);
  }
}
