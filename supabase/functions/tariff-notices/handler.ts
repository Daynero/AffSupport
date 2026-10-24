import { requireNamedWorkerSecret } from '../_shared/auth.ts';
import {
  emailSenderConfigured,
  type EmailDeliveryInput,
  type EmailMessage,
  type EmailDeliveryResult
} from '../_shared/email.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import { buildTariffNoticeEmail, noticeId, parseTariffNotice, teamLink } from './templates.ts';

/**
 * The tariff letters worker (feature 034, R9).
 *
 * Woken by `private.invoke_tariff_notices` when a notice is pending. It authenticates with the
 * catalog-sync worker secret, as catalog-updater does — function secrets are project-wide, and a
 * second one would be a manual production step. Each run claims leased batches, writes one letter
 * per notice and finishes every notice it claimed: sent, failed with a short reason (the database
 * retries up to three times), or skipped in beta, where nothing may reach a real inbox.
 *
 * Logs carry the notice id, its kind and a fixed reason word — never an address, a name or a key.
 */

export interface TariffNoticesDeps {
  /** `CATALOG_SYNC_SECRET`. */
  secret: string | undefined;
  environment: 'beta' | 'production';
  /** `WISHLY_SITE_URL`. */
  siteUrl: string;
  sender: { apiKey: string; from: string };
  /** `service_claim_tariff_notices(p_limit)`. */
  claim: (limit: number) => Promise<unknown[]>;
  /** `service_finish_tariff_notice(p_id, p_sent, p_error, p_skipped)`. */
  finish: (id: string, sent: boolean, error: string | null, skipped: boolean) => Promise<boolean>;
  send: (input: EmailDeliveryInput) => Promise<EmailDeliveryResult>;
  /** Trusted local tooling only; never supplied by the deployed entrypoint or request body. */
  capture?: (id: string, kind: string, message: EmailMessage) => Promise<void>;

  /** Operational wall time: deadlines only, never the acceptance tariff overlay. */
  now: () => number;
  /** Trusted tariff-domain instant for letter rendering; production supplies real time. */
  tariffNow: () => number;
  log?: (message: string, detail: Record<string, string | number | boolean | null>) => void;
}

export interface TariffNoticesSummary {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Durable local records, independent of whether the database finish was acknowledged. */
  captured?: number;
}

export const CLAIM_LIMIT = 20;
const MAX_BATCHES = 5;
const BUDGET_MS = 30_000;

export async function runTariffNotices(deps: TariffNoticesDeps): Promise<TariffNoticesSummary> {
  if (
    deps.capture &&
    (deps.environment !== 'beta' ||
      !['http://127.0.0.1:5175', 'http://127.0.0.1:5175/'].includes(deps.siteUrl) ||
      deps.sender.apiKey.trim() ||
      deps.sender.from.trim())
  )
    throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: false });
  const summary: TariffNoticesSummary = {
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    ...(deps.capture ? { captured: 0 } : {})
  };
  const beta = deps.environment === 'beta';
  const startedAt = deps.now();
  const seen = new Set<string>();
  const log = deps.log ?? (() => undefined);

  const finish = async (
    id: string,
    kind: string,
    sent: boolean,
    reason: string | null,
    skipped: boolean
  ): Promise<boolean> => {
    try {
      return (await deps.finish(id, sent, reason, skipped)) === true;
    } catch {
      log('tariff-notice-finish-failed', { id, kind });
      return false;
    }
  };

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    if (deps.now() - startedAt > BUDGET_MS) break;
    const rows = await deps.claim(CLAIM_LIMIT);
    if (rows.length === 0) break;
    let fresh = 0;

    for (const row of rows) {
      const id = noticeId(row);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      fresh += 1;
      summary.claimed += 1;

      const notice = parseTariffNotice(row);
      if (!notice) {
        summary.failed += 1;
        log('tariff-notice-invalid', { id });
        if (id) await finish(id, 'unknown', false, 'invalid_notice', false);
        continue;
      }

      const render = () =>
        buildTariffNoticeEmail(notice, {
          siteUrl: deps.siteUrl,
          now: notice.tariffToday
            ? Date.parse(notice.tariffToday + 'T12:00:00.000Z')
            : deps.tariffNow()
        });
      if (beta) {
        if (deps.capture) {
          try {
            await deps.capture(notice.id, notice.kind, render());
            summary.captured = (summary.captured ?? 0) + 1;
          } catch {
            log('tariff-notice-capture-failed', { id: notice.id, kind: notice.kind });
            await finish(notice.id, notice.kind, false, 'capture_failed', false);
            summary.failed += 1;
            continue;
          }
        }
        // Beta never delivers: a captured or ordinary beta letter is skipped.
        if (await finish(notice.id, notice.kind, false, null, true)) summary.skipped += 1;
        else summary.failed += 1;
        continue;
      }

      let delivery: EmailDeliveryResult;
      try {
        delivery = await deps.send({
          apiKey: deps.sender.apiKey,
          from: deps.sender.from,
          to: notice.recipientEmail,
          message: render()
        });
      } catch {
        delivery = { state: 'failed', reason: 'network' };
      }

      if (delivery.state === 'sent') {
        // A letter that went out counts as sent even if recording it failed: the lease expires
        // and the database decides; counting it as failed would hide a delivered letter.
        await finish(notice.id, notice.kind, true, null, false);
        summary.sent += 1;
      } else {
        log('tariff-notice-delivery-failed', {
          id: notice.id,
          kind: notice.kind,
          reason: delivery.reason
        });
        await finish(notice.id, notice.kind, false, delivery.reason, false);
        summary.failed += 1;
      }
    }

    // A batch of rows already handled in this run means the queue is handing them back (a retry
    // after a failure); they wait for the next run instead of spending their attempts now.
    if (fresh === 0 || rows.length < CLAIM_LIMIT) break;
  }

  return summary;
}

export async function handleTariffNoticesRequest(
  request: Request,
  deps: TariffNoticesDeps
): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(new TeamFunctionError('INVALID_INPUT', { retryable: false }));
  }
  try {
    // An empty string, never undefined: the helper's default would read the environment itself.
    await requireNamedWorkerSecret(request, deps.secret ?? '', 'x-catalog-sync-secret');
    try {
      teamLink(deps.siteUrl);
    } catch {
      throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: false });
    }
    // Outside beta, nothing is claimed that could not be sent: a missing key would otherwise
    // spend every notice's attempts on a configuration mistake.
    if (
      deps.environment !== 'beta' &&
      !emailSenderConfigured(deps.sender.apiKey, deps.sender.from)
    ) {
      throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: false });
    }
    return successResponse(await runTariffNotices(deps));
  } catch (error) {
    return errorResponse(mapUnknownError(error));
  }
}
