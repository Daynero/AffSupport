import { escapeHtml, safePlainText, sendEmail, type EmailMessage } from '../_shared/email.ts';

export type InvitationEmailMessage = EmailMessage;

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
      `${inviterName} invited you to the “${teamName}” space in Soty.`,
      `Accept the invitation: ${inviteUrl}`,
      '',
      `${inviterName} запрошує вас до простору «${teamName}» у Soty.`,
      `Прийняти запрошення: ${inviteUrl}`
    ].join('\n'),
    html: `<!doctype html>
<html lang="en">
  <body style="font-family:system-ui,-apple-system,sans-serif;color:#171717;line-height:1.5">
    <h1 style="font-size:20px">You’re invited to ${htmlTeam}</h1>
    <p>${htmlInviter} invited you to work with them in Soty.</p>
    <p><a href="${htmlUrl}">Accept invitation</a></p>
    <hr style="border:0;border-top:1px solid #e5e5e5">
    <h2 style="font-size:18px">Вас запрошено до ${htmlTeam}</h2>
    <p>${htmlInviter} запрошує вас працювати разом у Soty.</p>
    <p><a href="${htmlUrl}">Прийняти запрошення</a></p>
  </body>
</html>`
  };
}

/** The invitation contract stays content-free: any failure is one code, whatever the reason. */
export async function sendInvitationEmail(
  input: InvitationDeliveryInput,
  fetchImpl: typeof fetch = fetch
): Promise<InvitationDeliveryResult> {
  const result = await sendEmail(input, fetchImpl);
  return result.state === 'sent'
    ? { state: 'sent', errorCode: null }
    : { state: 'failed', errorCode: 'DELIVERY_UNAVAILABLE' };
}
