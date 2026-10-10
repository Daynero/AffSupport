/**
 * One way to send an email from an edge function (feature 034, T010).
 *
 * Invitations (team-invitations) and tariff notices (tariff-notices) go through the same Resend
 * account. The sender knows nothing about what it sends: a caller builds the message, this posts
 * it, and the answer is `sent` or `failed` with a short reason made of fixed words and a status
 * number — never the provider's body, the key, or the recipient, so a reason is safe to store and
 * to log.
 */

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

export interface EmailDeliveryInput {
  apiKey: string;
  from: string;
  to: string;
  message: EmailMessage;
}

export type EmailFailureReason =
  | 'not_configured'
  | 'invalid_recipient'
  | 'provider_response'
  | 'timeout'
  | 'network'
  | `provider_http_${number}`;

export type EmailDeliveryResult =
  { state: 'sent'; reason: null } | { state: 'failed'; reason: EmailFailureReason };

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case "'":
        return '&#39;';
      default:
        return '&quot;';
    }
  });
}

/** One line of plain text: no markup brackets, no control characters, no runs of whitespace. */
export function safePlainText(value: string): string {
  return (
    value
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[<>\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Whether the sender has what it needs before anything is claimed or attempted. */
export function emailSenderConfigured(apiKey: string, from: string): boolean {
  return apiKey.length >= 12 && from.length >= 3 && from.length <= 320;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export async function sendEmail(
  input: EmailDeliveryInput,
  fetchImpl: typeof fetch = fetch
): Promise<EmailDeliveryResult> {
  if (!emailSenderConfigured(input.apiKey, input.from)) {
    return { state: 'failed', reason: 'not_configured' };
  }
  if (input.to.length < 3 || input.to.length > 320) {
    return { state: 'failed', reason: 'invalid_recipient' };
  }

  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.message.subject,
        html: input.message.html,
        text: input.message.text
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : 0;
      return { state: 'failed', reason: `provider_http_${status}` };
    }
    const payload: unknown = await response.json().catch(() => null);
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof (payload as Record<string, unknown>).id !== 'string'
    ) {
      return { state: 'failed', reason: 'provider_response' };
    }
    return { state: 'sent', reason: null };
  } catch (error) {
    return { state: 'failed', reason: isTimeout(error) ? 'timeout' : 'network' };
  }
}
