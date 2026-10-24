import { isRecord } from '@video-compressor/shared';
import { publicConfig } from '../lib/config';
import { getSupabaseClient } from '../lib/supabase';
import type { PendingAnalyticsEvent } from './service';

export const ACCEPTANCE_CAPTURE_KEY = 'soty.acceptance.capture.v1';
interface CaptureConfiguration {
  development: boolean;
  environment: string;
  origin: string;
  supabaseUrl: string;
  campaignId: string;
}
export function acceptanceCaptureAllowed(config: CaptureConfiguration): boolean {
  return (
    config.development &&
    config.environment === 'beta' &&
    config.origin === 'http://127.0.0.1:5175' &&
    config.supabaseUrl === 'http://127.0.0.1:54321' &&
    /^acceptance-[a-z0-9][a-z0-9-]{2,63}$/.test(config.campaignId)
  );
}

/** Separate bounded test queue. It never changes analyticsEnabled or production delivery. */
type CaptureReceipt = boolean | ReadonlySet<string>;
export class AcceptanceCaptureQueue<T extends { event_id: string }> {
  private queue: Array<{ event: T; attempts: number }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private inFlight = 0;
  private sending = false;
  private stopped = false;
  private accepted = 0;
  private dropped = 0;
  constructor(
    private readonly sender: (events: T[], signal: AbortSignal) => Promise<CaptureReceipt>
  ) {}
  enqueue(event: T): void {
    if (this.stopped) return;
    if (this.queue.length + this.inFlight >= 60) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push({ event, attempts: 0 });
    this.schedule();
  }
  status() {
    return {
      queued: this.queue.length + this.inFlight,
      accepted: this.accepted,
      dropped: this.dropped,
      deliveryKnown: !this.sending && this.queue.length === 0 && this.dropped === 0
    };
  }
  private schedule() {
    if (this.timer || this.stopped || !this.queue.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 2000);
  }
  async flush(): Promise<void> {
    if (this.sending || this.stopped || !this.queue.length) return;
    this.sending = true;
    const batch = this.queue.splice(0, 25);
    this.inFlight = batch.length;
    const controller = new AbortController();
    this.controller = controller;
    let completeAbort: () => void = () => {};
    const aborted = new Promise<boolean>(resolve => {
      completeAbort = () => resolve(false);
      controller.signal.addEventListener('abort', completeAbort, { once: true });
    });
    const deadline = setTimeout(() => controller.abort(), 10000);
    try {
      let accepted: CaptureReceipt = false;
      try {
        accepted = await Promise.race([
          this.sender(
            batch.map(item => item.event),
            controller.signal
          ),
          aborted
        ]);
      } catch {
        /* Unknown delivery remains pending until bounded exhaustion. */
      }
      const receipt = accepted;
      const delivered = batch.filter(
        item =>
          receipt === true || (typeof receipt === 'object' && receipt.has(item.event.event_id))
      );
      this.accepted += delivered.length;
      const pending = batch.filter(item => !delivered.includes(item));
      for (const item of pending) item.attempts++;
      const remaining = pending.filter(item => item.attempts < 3 && !this.stopped);
      this.dropped += pending.length - remaining.length;
      this.queue = [...remaining, ...this.queue];
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', completeAbort);
      this.controller = null;
      this.inFlight = 0;
      this.sending = false;
      this.schedule();
    }
  }
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dropped += this.queue.length;
    this.queue = [];
  }
}

let capture: AcceptanceCaptureQueue<PendingAnalyticsEvent> | null = null;
let captureIdentity: string | null = null;
let admittedIdentity: string | null = null;
let captureGeneration = 0;
export function resetAcceptanceCapture(): void {
  captureGeneration++;
  capture?.stop();
  capture = null;
  captureIdentity = null;
  admittedIdentity = null;
}
function currentAcceptanceCampaign(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined' || !publicConfig.ok) return null;
  let campaignId: string;
  try {
    campaignId = window.sessionStorage.getItem(ACCEPTANCE_CAPTURE_KEY) ?? '';
  } catch {
    return null;
  }
  if (
    !acceptanceCaptureAllowed({
      development: import.meta.env.DEV,
      environment: publicConfig.value.environment,
      origin: window.location.origin,
      supabaseUrl: publicConfig.value.supabaseUrl,
      campaignId
    })
  )
    return null;
  return campaignId;
}
export function acceptanceCaptureActive(): boolean {
  return currentAcceptanceCampaign() !== null;
}

export function captureAcceptanceEvent(
  event: PendingAnalyticsEvent,
  sender: (events: PendingAnalyticsEvent[], signal: AbortSignal) => Promise<CaptureReceipt>
): void {
  const campaignId = currentAcceptanceCampaign();
  if (!campaignId) return;
  const identity = `${campaignId}/${event.user_id}`;
  if (captureIdentity !== identity) {
    resetAcceptanceCapture();
    const generation = captureGeneration;
    captureIdentity = identity;
    admittedIdentity = null;
    capture = new AcceptanceCaptureQueue(async (events, signal) => {
      if (currentAcceptanceCampaign() !== campaignId) return false;
      const client = getSupabaseClient();
      if (!client) return false;
      const session = await client.auth.getSession();
      if (
        session.error ||
        !acceptanceActorAllowed(session.data.session?.user, event.user_id, campaignId)
      )
        return false;
      if (
        signal.aborted ||
        generation !== captureGeneration ||
        captureIdentity !== identity ||
        currentAcceptanceCampaign() !== campaignId
      )
        return false;
      admittedIdentity = identity;
      return sender(events, signal);
    });
  }
  capture?.enqueue(event);
}
export function acceptanceCaptureStatus() {
  return capture?.status() ?? null;
}

export function acceptanceActorAllowed(
  value: unknown,
  userId: string,
  campaignId: string
): boolean {
  return (
    isRecord(value) &&
    value.id === userId &&
    isRecord(value.user_metadata) &&
    /^acceptance-[a-z0-9][a-z0-9-]{2,63}$/.test(campaignId) &&
    value.user_metadata.acceptance_namespace === campaignId
  );
}
export function acceptanceCaptureAdmitted(userId: string | null): boolean {
  const campaignId = currentAcceptanceCampaign();
  return Boolean(campaignId && userId && admittedIdentity === `${campaignId}/${userId}`);
}
