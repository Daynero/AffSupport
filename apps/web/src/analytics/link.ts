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
