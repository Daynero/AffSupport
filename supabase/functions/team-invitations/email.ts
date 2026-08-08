export interface InvitationEmailMessage {
  subject: string;
  html: string;
  text: string;
}

export interface InvitationEmailInput {
  teamName: string;
  inviterName: string;
  inviteUrl: string;
}

export interface InvitationDeliveryInput {
  apiKey: string;
  from: string;
  to: string;
  message: InvitationEmailMessage;
}

export interface InvitationDeliveryResult {
  state: 'sent' | 'failed';
  errorCode: 'DELIVERY_UNAVAILABLE' | null;
}

function escapeHtml(value: string): string {
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

function safePlainText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[<>\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeInviteUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost'
  ) {
    throw new TypeError('Invitation URL must use HTTPS.');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

export function buildInvitationEmail(input: InvitationEmailInput): InvitationEmailMessage {
  const teamName = safePlainText(input.teamName).slice(0, 120);
  const inviterName = safePlainText(input.inviterName).slice(0, 120) || 'Soty member';
  const inviteUrl = safeInviteUrl(input.inviteUrl);
  const htmlTeam = escapeHtml(input.teamName.normalize('NFC').trim().slice(0, 120));
  const htmlInviter = escapeHtml(inviterName);
  const htmlUrl = escapeHtml(inviteUrl);

  return {
    subject: `${inviterName} invited you to ${teamName} in Soty`,
    text: [
      `${inviterName} invited you to the “${teamName}” team in Soty.`,
      `Accept the invitation: ${inviteUrl}`,
      '',
      `${inviterName} запрошує вас до команди «${teamName}» у Soty.`,
      `Прийняти запрошення: ${inviteUrl}`
    ].join('\n'),
    html: `<!doctype html>
<html lang="en">
  <body style="font-family:system-ui,-apple-system,sans-serif;color:#171717;line-height:1.5">
    <h1 style="font-size:20px">You’re invited to ${htmlTeam}</h1>
    <p>${htmlInviter} invited you to collaborate in Soty.</p>
    <p><a href="${htmlUrl}">Accept invitation</a></p>
    <hr style="border:0;border-top:1px solid #e5e5e5">
    <h2 style="font-size:18px">Вас запрошено до ${htmlTeam}</h2>
    <p>${htmlInviter} запрошує вас до спільної роботи у Soty.</p>
    <p><a href="${htmlUrl}">Прийняти запрошення</a></p>
  </body>
</html>`
  };
}

export async function sendInvitationEmail(
  input: InvitationDeliveryInput,
  fetchImpl: typeof fetch = fetch
): Promise<InvitationDeliveryResult> {
  if (
    input.apiKey.length < 12 ||
    input.from.length < 3 ||
    input.from.length > 320 ||
    input.to.length < 3 ||
    input.to.length > 320
  ) {
    return { state: 'failed', errorCode: 'DELIVERY_UNAVAILABLE' };
  }

  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
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
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return { state: 'failed', errorCode: 'DELIVERY_UNAVAILABLE' };
    const payload: unknown = await response.json().catch(() => null);
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof (payload as Record<string, unknown>).id !== 'string'
    ) {
      return { state: 'failed', errorCode: 'DELIVERY_UNAVAILABLE' };
    }
    return { state: 'sent', errorCode: null };
  } catch {
    return { state: 'failed', errorCode: 'DELIVERY_UNAVAILABLE' };
  }
}
