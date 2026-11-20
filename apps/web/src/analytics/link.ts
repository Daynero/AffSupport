/**
 * 032 — analytics of the browser ↔ Soty Agent link (FR-024…FR-026).
 *
 * One helper per event, each attaching exactly the properties the data model
 * lists and nothing an attacker could learn from: no token, no URL, no nonce,
 * no instance id. The browser family and the page origin are coarse
 * categories (FR-024) rather than a fingerprint.
 *
 * `flowId` is the id of the link attempt (or of the stream session); the
 * service routes it into the envelope's `flow_id` column so `journey <email>`
 * lines up every event of one attempt.
 */
import { currentBrowserFamily } from '../lib/browser';
import { servedByAgent } from '../lib/config';
import {
  LINK_DURATION_MAX_MS,
  type LinkOrigin,
  type LinkReasonProp,
  type LinkStage,
  type LinkTransport,
  type LinkTrigger,
  type PairingMethod,
  type ReconnectSurface,
  type RecoveryMode
} from './events';
import { analytics, type ProductAnalytics } from './service';

export type {
  LinkTrigger,
  LinkReasonProp,
  LinkStage,
  LinkTransport,
  RecoveryMode,
  ReconnectSurface,
  PairingMethod
};

type LinkTracker = Pick<ProductAnalytics, 'track'>;

/**
 * Where this page came from: the hosted site, or the copy the Agent serves on
 * loopback (what Safari users are sent to when the hosted origin is blocked).
 */
export function linkOrigin(): LinkOrigin {
  if (typeof location === 'undefined') return 'hosted';
  return servedByAgent() ? 'local_copy' : 'hosted';
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), LINK_DURATION_MAX_MS);
}

export function trackLinkCheckStarted(
  input: { flowId: string; trigger: LinkTrigger },
  tracker: LinkTracker = analytics
): void {
  tracker.track('link_check_started', {
    flow_id: input.flowId,
    link_trigger: input.trigger,
    link_origin: linkOrigin(),
    browser_family: currentBrowserFamily()
  });
}

export function trackLinkCheckCompleted(
  input: {
    flowId: string;
    outcome: 'success' | 'failure' | 'blocked';
    reason?: LinkReasonProp;
    stage?: LinkStage;
    durationMs: number;
  },
  tracker: LinkTracker = analytics
): void {
  tracker.track('link_check_completed', {
    flow_id: input.flowId,
    outcome: input.outcome,
    duration_ms: boundedDuration(input.durationMs),
    ...(input.reason ? { link_reason: input.reason } : {}),
    ...(input.stage ? { link_stage: input.stage } : {})
  });
}

export interface LinkCheckReport {
  /**
   * Something other than the retry loop now waits for this check's answer — a person pressed
   * Reconnect, the tab came back, a request failed. From here on it is reported like any
   * check that was asked for, whatever it answers.
   */
  asked(): void;
  complete(input: {
    outcome: 'success' | 'failure' | 'blocked';
    reason?: LinkReasonProp;
    stage?: LinkStage;
    durationMs: number;
  }): void;
}

export interface LinkCheckReporter {
  begin(input: { flowId: string; trigger: LinkTrigger }): LinkCheckReport;
}

/** A failure that goes on is said again this often, so it is never said only once. */
export const LINK_REPEAT_REPORT_MS = 60 * 60 * 1000;

/**
 * Reports link checks without reporting the polling.
 *
 * A page left open while Soty is not running retries every fifteen seconds for as long as
 * it stays open, and each retry used to send `link_check_started` and an identical
 * `link_check_completed`. Measured over one week in November 2026: 53 218 failed checks
 * against 623 successes, 45 000 of them background retries from a handful of forgotten
 * tabs — a quarter of every event the product stored, saying one thing.
 *
 * So a background retry (`trigger: 'retry'`) that ends exactly like the failure already
 * reported — same outcome, reason and stage — is not reported. Its `started` waits for the
 * answer, so a pair is always sent whole or not at all (the coverage registry correlates the
 * two by `flow_id`). What still is sent:
 *
 *  - the first failure of a streak, a retry that succeeds, a retry that fails differently;
 *  - every check a person or the page itself asked for, including a background retry that
 *    such a request joined while it was running ({@link LinkCheckReport.asked});
 *  - the same failure again once an hour. A report can be lost on the way, an account can
 *    change under an open tab, and a reader looking at one day must still see a tab that
 *    has been failing since the day before;
 *  - every `pairing_rejected`, however often: a token refused again and again is the loop
 *    `analytics investigate` counts rejections to find.
 *
 * How long a break lasted is on `link_recovered`, which is unaffected.
 */
export function createLinkCheckReporter(
  tracker: LinkTracker = analytics,
  now: () => number = Date.now
): LinkCheckReporter {
  // The failure the current streak last reported, and when; null after a success.
  let reported: { signature: string; at: number } | null = null;
  return {
    begin({ flowId, trigger }) {
      let deferred = trigger === 'retry' && reported !== null;
      let finished = false;
      if (!deferred) trackLinkCheckStarted({ flowId, trigger }, tracker);
      return {
        asked() {
          if (!deferred || finished) return;
          deferred = false;
          trackLinkCheckStarted({ flowId, trigger }, tracker);
        },
        complete(input) {
          if (finished) return;
          finished = true;
          const signature =
            input.outcome === 'success'
              ? null
              : `${input.outcome}|${input.reason ?? ''}|${input.stage ?? ''}`;
          const at = now();
          if (deferred) {
            // Wall-clock time: only a moment that is both later and within the hour counts
            // as "already said", so a clock set backwards cannot silence the tab.
            const alreadySaid =
              signature !== null &&
              reported !== null &&
              signature === reported.signature &&
              input.reason !== 'pairing_rejected' &&
              at >= reported.at &&
              at - reported.at < LINK_REPEAT_REPORT_MS;
            if (alreadySaid) return;
            trackLinkCheckStarted({ flowId, trigger }, tracker);
          }
          reported = signature === null ? null : { signature, at };
          trackLinkCheckCompleted({ flowId, ...input }, tracker);
        }
      };
    }
  };
}

export function trackLinkLost(
  input: { flowId: string; transport: LinkTransport; reason?: LinkReasonProp },
  tracker: LinkTracker = analytics
): void {
  tracker.track('link_lost', {
    flow_id: input.flowId,
    link_transport: input.transport,
    ...(input.reason ? { link_reason: input.reason } : {})
  });
}

export function trackLinkRecovered(
  input: {
    flowId: string;
    durationMs: number;
    mode: RecoveryMode;
    instanceChanged: boolean;
    tokenChanged: boolean;
  },
  tracker: LinkTracker = analytics
): void {
  tracker.track('link_recovered', {
    flow_id: input.flowId,
    duration_ms: boundedDuration(input.durationMs),
    recovery_mode: input.mode,
    instance_changed: input.instanceChanged,
    token_changed: input.tokenChanged
  });
}

export function trackReconnectClicked(
  input: { flowId: string; surface: ReconnectSurface },
  tracker: LinkTracker = analytics
): void {
  tracker.track('reconnect_clicked', { flow_id: input.flowId, surface: input.surface });
}

export function trackBlockedByBrowser(tracker: LinkTracker = analytics): void {
  tracker.track('blocked_by_browser_detected', {
    browser_family: currentBrowserFamily(),
    link_origin: linkOrigin()
  });
}

/**
 * FR-026 — the stream says "open" while a request says "no". Both facts travel
 * together; this is the one event that names the class of bug 032 exists for.
 */
export function trackLinkInconsistency(
  input: {
    flowId: string;
    errorCode: 'unauthorized' | 'forbidden' | 'connection_failed';
    streamOpen: boolean;
  },
  tracker: LinkTracker = analytics
): void {
  tracker.track('link_inconsistency', {
    flow_id: input.flowId,
    link_transport: 'request',
    error_code: input.errorCode,
    link_stream_open: input.streamOpen
  });
}

export function trackPairing(
  stage: 'started' | 'completed' | 'failed',
  input: { flowId: string; method: PairingMethod; reason?: LinkReasonProp },
  tracker: LinkTracker = analytics
): void {
  tracker.track(`pairing_${stage}`, {
    flow_id: input.flowId,
    pairing_method: input.method,
    ...(input.reason ? { link_reason: input.reason } : {})
  });
}
