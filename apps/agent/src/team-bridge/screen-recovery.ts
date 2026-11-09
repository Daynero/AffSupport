/** One bounded preparation: retain successful slots and replace only proved file defects.
 * The provider owns durable selection authority and accounting; this coordinator never
 * treats a lost acknowledgement or a transport failure as permission for another draw.
 */
import {
  parseRestitchScreens,
  RESTITCH_SCREEN_SELECTION_MAX_CANDIDATES,
  type RestitchScreen
} from '@video-compressor/shared';
import { ScreenCacheError, type ResolvedScreen } from './screen-cache.js';

export interface ScreenRecoveryCandidate {
  versionId: string;
  acquisition: number;
  screen: RestitchScreen;
}
export type ScreenDefect =
  'unsupported' | 'checksum_mismatch' | 'source_missing' | 'source_changed';
export interface ScreenRecoveryProvider {
  next(
    slot: RestitchScreen['slot'],
    signal: AbortSignal
  ): Promise<
    | { kind: 'candidate'; candidate: ScreenRecoveryCandidate }
    | {
        kind: 'exhausted';
        reason: 'empty' | 'unusable' | 'remembered' | 'limit';
        complete: boolean;
      }
  >;
  resolve(
    candidate: ScreenRecoveryCandidate,
    signal: AbortSignal
  ): Promise<{ candidate: ScreenRecoveryCandidate; resolved: ResolvedScreen }>;
  reject(
    candidate: ScreenRecoveryCandidate,
    defect: ScreenDefect,
    signal: AbortSignal
  ): Promise<void>;
  accept(candidate: ScreenRecoveryCandidate, signal: AbortSignal): Promise<void>;
  refresh(
    candidate: ScreenRecoveryCandidate,
    signal: AbortSignal
  ): Promise<ScreenRecoveryCandidate>;
}
export class ScreenRecoveryCandidateError extends Error {
  #candidate: ScreenRecoveryCandidate;
  #failure: unknown;

  constructor(candidate: ScreenRecoveryCandidate, failure: unknown) {
    super('SCREEN_RECOVERY_CANDIDATE_FAILED');
    this.#candidate = candidate;
    this.#failure = failure;
  }

  get candidate(): ScreenRecoveryCandidate {
    return this.#candidate;
  }

  get failure(): unknown {
    return this.#failure;
  }
}
function checked(
  value: ScreenRecoveryCandidate,
  slot: RestitchScreen['slot']
): ScreenRecoveryCandidate {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.versionId
    ) ||
    !Number.isInteger(value.acquisition) ||
    value.acquisition < 0 ||
    value.acquisition > 2 ||
    value.screen?.slot !== slot
  )
    throw new ScreenCacheError('INVALID_RESPONSE');
  const parsed = parseRestitchScreens([value.screen]);
  if (!parsed.ok || !parsed.value?.[0]) throw new ScreenCacheError('INVALID_RESPONSE');
  const screen = parsed.value[0];
  // Keep the selected identity independent of retained provider objects and of
  // later mutations through the argument supplied to resolve/reject/accept.
  if (screen.transfer) Object.freeze(screen.transfer);
  return Object.freeze({
    versionId: value.versionId.toLowerCase(),
    acquisition: value.acquisition,
    screen: Object.freeze(screen)
  });
}
function sameVersion(
  previous: ScreenRecoveryCandidate,
  next: ScreenRecoveryCandidate
): ScreenRecoveryCandidate {
  next = checked(next, previous.screen.slot);
  if (
    next.versionId !== previous.versionId ||
    next.acquisition < previous.acquisition ||
    (['materialId', 'checksum', 'mimeType', 'sizeBytes', 'slot'] as const).some(
      key => next.screen[key] !== previous.screen[key]
    )
  )
    throw new ScreenCacheError('INVALID_RESPONSE');
  return next;
}
function defect(cause: unknown): ScreenDefect | null {
  if (!(cause instanceof ScreenCacheError) || cause.reason === 'cache_write_failed') return null;
  if (
    ['PERMISSION_DENIED', 'DRIVE_UNAVAILABLE', 'RATE_LIMITED', 'DISK_FULL', 'EXPIRED'].includes(
      cause.code
    )
  )
    return null;
  if (['checksum_mismatch', 'source_missing', 'source_changed'].includes(cause.reason))
    return cause.reason as ScreenDefect;
  return cause.code === 'RESTITCH_SCREEN_UNSUPPORTED' ? 'unsupported' : null;
}
export async function resolveScreensWithRecovery(
  slots: readonly RestitchScreen['slot'][],
  provider: ScreenRecoveryProvider,
  signal: AbortSignal,
  onProgress?: (progress: {
    slot: RestitchScreen['slot'];
    stage: 'selecting' | 'rejected' | 'ready';
    candidates: number;
  }) => void
): Promise<ResolvedScreen[]> {
  slots = [...slots];
  if (
    slots.some(slot => slot !== 'start' && slot !== 'end') ||
    new Set(slots).size !== slots.length
  )
    throw new ScreenCacheError('INVALID_RESPONSE');
  const result: ResolvedScreen[] = [];
  for (const slot of slots) {
    const seen = new Set<string>();
    let refreshes = 0;
    const progress = (stage: 'selecting' | 'rejected' | 'ready') => {
      try {
        onProgress?.({ slot, stage, candidates: seen.size });
      } catch {
        /* diagnostics cannot stop preparation */
      }
    };
    for (;;) {
      signal.throwIfAborted();
      progress('selecting');
      const selection = await provider.next(slot, signal);
      signal.throwIfAborted();
      if (selection.kind === 'exhausted') {
        if (
          typeof selection.complete !== 'boolean' ||
          !['empty', 'unusable', 'remembered', 'limit'].includes(selection.reason)
        )
          throw new ScreenCacheError('INVALID_RESPONSE');
        const code =
          !selection.complete || selection.reason === 'limit'
            ? 'RESTITCH_SCREEN_SELECTION_LIMIT'
            : selection.reason === 'empty'
              ? 'RESTITCH_POOL_EMPTY'
              : selection.reason === 'remembered'
                ? 'RESTITCH_SCREEN_PREVIOUS_FAILURES'
                : 'RESTITCH_SCREEN_CANDIDATES_EXHAUSTED';
        throw new ScreenCacheError(code);
      }
      if (selection.kind !== 'candidate') throw new ScreenCacheError('INVALID_RESPONSE');
      let candidate = checked(selection.candidate, slot);
      if (seen.has(candidate.versionId)) throw new ScreenCacheError('INVALID_RESPONSE');
      if (seen.size >= RESTITCH_SCREEN_SELECTION_MAX_CANDIDATES)
        throw new ScreenCacheError('RESTITCH_SCREEN_SELECTION_LIMIT');
      seen.add(candidate.versionId);
      let refreshed = false;
      let resolved: ResolvedScreen | null = null;
      while (!resolved) {
        signal.throwIfAborted();
        try {
          const reply = await provider.resolve(candidate, signal);
          signal.throwIfAborted();
          candidate = sameVersion(candidate, reply.candidate);
          if (
            !reply.resolved ||
            reply.resolved.slot !== slot ||
            typeof reply.resolved.id !== 'string' ||
            !reply.resolved.id ||
            typeof reply.resolved.path !== 'string' ||
            !reply.resolved.path
          )
            throw new ScreenCacheError('INVALID_RESPONSE');
          resolved = { slot, id: reply.resolved.id, path: reply.resolved.path };
        } catch (error) {
          signal.throwIfAborted();
          const cause = error instanceof ScreenRecoveryCandidateError ? error.failure : error;
          if (error instanceof ScreenRecoveryCandidateError)
            candidate = sameVersion(candidate, error.candidate);
          if (
            cause instanceof ScreenCacheError &&
            cause.code === 'EXPIRED' &&
            !refreshed &&
            refreshes < 2
          ) {
            const replacement = await provider.refresh(candidate, signal);
            signal.throwIfAborted();
            candidate = sameVersion(candidate, replacement);
            refreshed = true;
            refreshes++;
            continue;
          }
          const refusal = defect(cause);
          if (!refusal) throw cause;
          await provider.reject(candidate, refusal, signal);
          signal.throwIfAborted();
          progress('rejected');
          break;
        }
      }
      if (!resolved) continue;
      // An uncertain acknowledgement must stop here, outside the image-failure catch.
      await provider.accept(candidate, signal);
      signal.throwIfAborted();
      result.push(resolved);
      progress('ready');
      break;
    }
  }
  return result;
}
