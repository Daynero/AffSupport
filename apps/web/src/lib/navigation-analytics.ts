/**
 * One analytics event per route change (058, Analytics & Diagnostic Coverage).
 *
 * The router opens an attempt when a navigation is asked for and reports each
 * stage to it: prepared (the destination's code is in), committed (how it
 * moved, or why it did not), animation done, and content ready (no skeleton
 * left standing). The attempt then watches layout for two seconds and sends a
 * single `navigation_attempt_finished` — or sends early when a newer
 * navigation supersedes it, the person cancels it, or a chunk fails to load.
 *
 * Volume is bounded: every attempt with something to explain is sent (a
 * skeleton was seen, motion was skipped or degraded, it did not settle,
 * layout shifted, a long frame stalled it); ordinary ones are sampled at 10%,
 * and no analytics session sends more than 60. Nothing about where the person
 * was is sent — only the closed screen kind.
 */
import type { NAV_FINALS, NAV_HISTORY, NAV_MODES, NAV_SKIP_REASONS } from '../analytics/events';
import { analytics } from '../analytics/service';
import { productSessionId } from '../analytics/session';
import { currentBrowserFamily } from './browser';
import { beginMeasure, type MeasureWindow } from './motion-quality';
import type { MotionKind, ScreenKind } from './motion-registry';

export type NavMode = (typeof NAV_MODES)[number];
export type NavSkipReason = (typeof NAV_SKIP_REASONS)[number];
export type NavFinal = (typeof NAV_FINALS)[number];
export type NavHistory = (typeof NAV_HISTORY)[number];

export const NAV_SAMPLE_RATE = 0.1;
export const NAV_SESSION_CAP = 60;
/** How long layout is watched after the content is ready. */
export const NAV_SETTLE_WATCH_MS = 2_000;
/** An attempt still waiting for content after this is reported as it stands. */
const NAV_CONTENT_WAIT_MAX_MS = 30_000;
/** A layout-shift sum above this (×1000) is an anomaly worth sending. */
export const NAV_SHIFT_ANOMALY_MILLI = 50;

export interface AttemptStart {
  from: ScreenKind;
  to: ScreenKind;
  motion: Exclude<MotionKind, 'none'>;
  history: NavHistory;
}

export interface NavigationAttempt {
  prepared(): void;
  committed(mode: NavMode, skipReason: NavSkipReason): void;
  /** The animated part ended; returns the long frames seen during it. */
  animationDone(): number;
  /** The navigation ended before it settled. */
  finish(final: Exclude<NavFinal, 'settled'>): void;
}

type Sender = (
  properties: Parameters<typeof analytics.track<'navigation_attempt_finished'>>[1]
) => void;

let send: Sender = properties => analytics.track('navigation_attempt_finished', properties);
let random: () => number = Math.random;
let sessionKey: string | null = null;
let sentInSession = 0;

/* ---- Skeletons: the router cannot see Suspense, so skeletons report in. ---- */

let skeletonsShown = 0;
const skeletonListeners = new Set<() => void>();

/** Called by `RouteSkeleton` on mount; the returned function on unmount. */
export function skeletonVisible(): () => void {
  skeletonsShown += 1;
  skeletonListeners.forEach(listener => listener());
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    skeletonsShown = Math.max(0, skeletonsShown - 1);
    skeletonListeners.forEach(listener => listener());
  };
}

/* ---- Chunk failures reported by `recoverableLazy`. ---- */

let current: NavigationAttempt | null = null;

export function reportChunkFailure() {
  current?.finish('chunk_failed');
}

function admit(anomalous: boolean): boolean {
  let key: string | null;
  try {
    key = productSessionId();
  } catch {
    key = null;
  }
  if (key !== sessionKey) {
    sessionKey = key;
    sentInSession = 0;
  }
  if (sentInSession >= NAV_SESSION_CAP) return false;
  if (!anomalous && random() >= NAV_SAMPLE_RATE) return false;
  sentInSession += 1;
  return true;
}

function newFlowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  // Not reached in supported browsers; analytics drops a non-UUID flow id.
  return '00000000-0000-4000-8000-000000000000';
}

/**
 * Opens the attempt for a navigation. The previous attempt, if it has not
 * settled yet, ends as `superseded`. A `standalone` attempt (a navigation that
 * was cancelled before it began) leaves the running one alone.
 */
export function beginNavigationAttempt(
  start: AttemptStart,
  { standalone = false }: { standalone?: boolean } = {}
): NavigationAttempt {
  if (!standalone) current?.finish('superseded');
  const startedAt = performance.now();
  const flowId = newFlowId();
  let preparedAt: number | null = null;
  let mode: NavMode = 'animated';
  let skipReason: NavSkipReason = 'none';
  let ended = false;
  let skeletonSince: number | null = skeletonsShown > 0 ? startedAt : null;
  let skeletonMs = 0;
  let animationWindow: MeasureWindow | null = null;
  let totalWindow: MeasureWindow | null = null;
  let longFramesInAnimation = 0;
  let readyAt: number | null = null;
  let phase: 'preparing' | 'animating' | 'waiting' = 'preparing';
  let timers: ReturnType<typeof setTimeout>[] = [];

  const onSkeletons = () => {
    const now = performance.now();
    if (skeletonsShown > 0 && skeletonSince === null) skeletonSince = now;
    if (skeletonsShown === 0 && skeletonSince !== null) {
      skeletonMs += now - skeletonSince;
      skeletonSince = null;
      if (phase === 'waiting') contentReady();
    }
  };
  skeletonListeners.add(onSkeletons);

  const emit = (final: NavFinal) => {
    if (ended) return;
    ended = true;
    if (current === attempt) current = null;
    skeletonListeners.delete(onSkeletons);
    timers.forEach(clearTimeout);
    timers = [];
    const now = performance.now();
    if (skeletonSince !== null) skeletonMs += now - skeletonSince;
    animationWindow?.end();
    const measured = totalWindow?.end() ?? { longFrames: 0, layoutShift: 0 };
    const layoutShiftMilli = Math.round(measured.layoutShift * 1000);
    const longFrames = Math.max(measured.longFrames, longFramesInAnimation);
    const anomalous =
      final !== 'settled' ||
      skeletonMs > 0 ||
      mode !== 'animated' ||
      layoutShiftMilli > NAV_SHIFT_ANOMALY_MILLI ||
      longFrames > 0;
    if (!admit(anomalous)) return;
    send({
      flow_id: flowId,
      nav_from_screen: start.from,
      nav_to_screen: start.to,
      nav_motion: start.motion,
      nav_mode: mode,
      nav_skip_reason: skipReason,
      nav_final: final,
      nav_history: start.history,
      prepare_ms: Math.round((preparedAt ?? now) - startedAt),
      duration_ms: Math.round((readyAt ?? now) - startedAt),
      skeleton_ms: Math.round(skeletonMs),
      layout_shift_milli: layoutShiftMilli,
      long_frame_count: longFrames,
      browser_family: currentBrowserFamily()
    });
  };

  const contentReady = () => {
    if (ended || readyAt !== null) return;
    readyAt = performance.now();
    timers.push(setTimeout(() => emit('settled'), NAV_SETTLE_WATCH_MS));
  };

  const attempt: NavigationAttempt = {
    prepared() {
      if (preparedAt === null) preparedAt = performance.now();
    },
    committed(nextMode, nextReason) {
      if (preparedAt === null) preparedAt = performance.now();
      mode = nextMode;
      skipReason = nextReason;
      totalWindow = beginMeasure();
      if (nextMode === 'animated') {
        phase = 'animating';
        animationWindow = beginMeasure();
        return;
      }
      phase = 'waiting';
      // An instant swap: content is ready on the next frame unless a skeleton
      // stands in for it.
      const settle = () => {
        if (skeletonsShown === 0) contentReady();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(settle);
      else settle();
      timers.push(setTimeout(contentReadyOrGiveUp, NAV_CONTENT_WAIT_MAX_MS));
    },
    animationDone() {
      const measured = animationWindow?.end() ?? { longFrames: 0, layoutShift: 0 };
      animationWindow = null;
      phase = 'waiting';
      longFramesInAnimation = measured.longFrames;
      if (skeletonsShown === 0) contentReady();
      else timers.push(setTimeout(contentReadyOrGiveUp, NAV_CONTENT_WAIT_MAX_MS));
      return measured.longFrames;
    },
    finish(final) {
      emit(final);
    }
  };

  function contentReadyOrGiveUp() {
    if (readyAt === null) emit('settled');
  }

  if (!standalone) current = attempt;
  return attempt;
}

/** Tests only. */
export function setNavigationAnalyticsForTests(options: {
  sender?: Sender;
  random?: () => number;
}) {
  if (options.sender) send = options.sender;
  if (options.random) random = options.random;
  sessionKey = null;
  sentInSession = 0;
  skeletonsShown = 0;
  skeletonListeners.clear();
  current = null;
}
