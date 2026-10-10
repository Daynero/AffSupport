import { escapeHtml, safePlainText, type EmailMessage } from '../_shared/email.ts';

/**
 * The tariff letters (feature 034, US1/US5/US6): one owner, one event, one language.
 *
 * Copy follows the spec word for word where it gives one. Dates are written the way people say
 * them — «14 жовтня», "October 14" — with «включно» where the day itself still counts, and a
 * number of days never appears, so no letter can say "0 days". Every value that came from the
 * database is either flattened to plain text (subject, text part) or escaped (HTML part).
 */

export const TARIFF_NOTICE_KINDS = [
  'warn_3d',
  'warn_1d',
  'grace',
  'blocked',
  'granted',
  'renewed',
  'member_nudge'
] as const;
export type TariffNoticeKind = (typeof TARIFF_NOTICE_KINDS)[number];

export interface AdminContact {
  telegram: string | null;
  email: string | null;
}

/** One row of `service_claim_tariff_notices`, after parsing. */
export interface TariffNotice {
  id: string;
  kind: TariffNoticeKind;
  tariffId: string | null;
  teamId: string | null;
  teamName: string | null;
  recipientEmail: string;
  recipientName: string | null;
  locale: 'uk' | 'en';
  planNameUk: string | null;
  planNameEn: string | null;
  endsOn: string | null;
  graceUntil: string | null;
  updaterRunning: boolean;
  contact: AdminContact;
  memberName: string | null;
}

export interface TariffNoticeContext {
  /** `WISHLY_SITE_URL`; the letter links to `<site>/team`. */
  siteUrl: string;
  /** Epoch milliseconds; decides whether a date needs its year. */
  now: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TELEGRAM_LOGIN = /^[A-Za-z0-9_]{5,32}$/;
const EMAIL = /^[^\s@<>"()\\,;:]{1,64}@[^\s@<>"'()\\,;:]{1,255}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS_UK = [
  'січня',
  'лютого',
  'березня',
  'квітня',
  'травня',
  'червня',
  'липня',
  'серпня',
  'вересня',
  'жовтня',
  'листопада',
  'грудня'
];
const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const flat = safePlainText(value).slice(0, max).trim();
  return flat.length > 0 ? flat : null;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

export function safeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= 320 && EMAIL.test(trimmed) ? trimmed : null;
}

export function safeTelegram(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const login = value.trim().replace(/^@/, '');
  return TELEGRAM_LOGIN.test(login) ? login : null;
}

/** The notice id alone, so a row that fails to parse can still be finished. */
export function noticeId(row: unknown): string | null {
  return uuidOrNull(record(row)?.id);
}

/** A row of `service_claim_tariff_notices`, or null when it cannot make a correct letter. */
export function parseTariffNotice(row: unknown): TariffNotice | null {
  const value = record(row);
  if (!value) return null;
  const id = uuidOrNull(value.id);
  const kind = (TARIFF_NOTICE_KINDS as readonly string[]).includes(value.kind as string)
    ? (value.kind as TariffNoticeKind)
    : null;
  const recipientEmail = safeEmail(value.recipientEmail);
  if (!id || !kind || !recipientEmail) return null;
  const contact = record(value.contact);
  const notice: TariffNotice = {
    id,
    kind,
    tariffId: uuidOrNull(value.tariffId),
    teamId: uuidOrNull(value.teamId),
    teamName: text(value.teamName, 120),
    recipientEmail,
    recipientName: text(value.recipientName, 120),
    locale: value.locale === 'en' ? 'en' : 'uk',
    planNameUk: text(value.planNameUk, 60),
    planNameEn: text(value.planNameEn, 60),
    endsOn: typeof value.endsOn === 'string' ? value.endsOn : null,
    graceUntil: typeof value.graceUntil === 'string' ? value.graceUntil : null,
    updaterRunning: value.updaterRunning === true,
    contact: {
      telegram: safeTelegram(contact?.telegram),
      email: safeEmail(contact?.email)
    },
    memberName: text(value.memberName, 120)
  };
  // Every letter names a date except the member's nudge; a letter with a wrong date is worse
  // than none.
  if (kind !== 'member_nudge' && !kyivDay(notice.endsOn)) return null;
  if (kind === 'grace' && !kyivDay(notice.graceUntil)) return null;
  return notice;
}

/** `YYYY-MM-DD`, or the Kyiv calendar day of an ISO instant. */
function kyivDay(value: string | null): { year: number; month: number; day: number } | null {
  if (!value) return null;
  const plain = DAY.exec(value);
  if (plain) {
    const [year, month, day] = [Number(plain[1]), Number(plain[2]), Number(plain[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCMonth() === month - 1 && check.getUTCDate() === day
      ? { year, month, day }
      : null;
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  return kyivDayOf(instant);
}

function kyivDayOf(instant: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find(entry => entry.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/** «14 жовтня» / "October 14"; the year is added only when it is not the current Kyiv year. */
export function formatNoticeDate(value: string | null, locale: 'uk' | 'en', now: number): string {
  const day = kyivDay(value);
  if (!day) return '';
  const withYear = day.year !== kyivDayOf(now).year;
  if (locale === 'uk') {
    return `${day.day} ${MONTHS_UK[day.month - 1]}${withYear ? ` ${day.year} р.` : ''}`;
  }
  return `${MONTHS_EN[day.month - 1]} ${day.day}${withYear ? `, ${day.year}` : ''}`;
}

/** `<site>/team`; throws when the configured site cannot be linked to (checked before claiming). */
export function teamLink(siteUrl: string): string {
  const parsed = new URL(siteUrl);
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost'
  ) {
    throw new TypeError('Site URL must use HTTPS.');
  }
  return `${parsed.origin}/team`;
}

interface Copy {
  subject: string;
  /** Plain-text paragraphs; each is escaped for HTML separately. */
  paragraphs: string[];
  action: string;
  /** Whether the letter is about extending — then the admin contact is offered. */
  offerContact: boolean;
  /** What the prepared message to the administrator says. */
  adminMessage: string;
}

function quoteUk(value: string): string {
  return `«${value}»`;
}

function quoteEn(value: string): string {
  return `“${value}”`;
}

function copyFor(notice: TariffNotice, now: number): Copy {
  const uk = notice.locale === 'uk';
  const date = (value: string | null) => formatNoticeDate(value, notice.locale, now);
  const endsOn = date(notice.endsOn);
  const graceUntil = date(notice.graceUntil);
  const plan =
    (uk ? notice.planNameUk : notice.planNameEn) ?? notice.planNameUk ?? notice.planNameEn;
  const team = notice.teamName;
  const q = uk ? quoteUk : quoteEn;
  const tariff = uk
    ? plan
      ? `Тариф ${q(plan)}`
      : 'Тариф'
    : plan
      ? `Your ${q(plan)} plan`
      : 'Your plan';
  const forSpace = team ? (uk ? ` для простору ${q(team)}` : ` for the ${q(team)} space`) : '';
  const adminMessage = uk
    ? `Привіт! Хочу продовжити тариф${plan ? ` ${q(plan)}` : ''} для простору Soty${team ? ` ${q(team)}` : ''}. Моя пошта в Soty: ${notice.recipientEmail}`
    : `Hi! I’d like to extend the${plan ? ` ${q(plan)}` : ''} plan for my Soty space${team ? ` ${q(team)}` : ''}. My Soty email: ${notice.recipientEmail}`;

  switch (notice.kind) {
    case 'warn_3d':
      return {
        subject: uk
          ? `${tariff} діє до ${endsOn} включно`
          : `${tariff} is active through ${endsOn}`,
        paragraphs: [
          uk
            ? `${tariff}${forSpace} діє до ${endsOn} включно.`
            : `${tariff}${forSpace} is active through ${endsOn}.`,
          graceLine(uk, graceUntil),
          ...updaterLine(notice, uk, graceUntil, false)
        ].filter(Boolean),
        action: uk ? 'Відкрити простір' : 'Open the space',
        offerContact: true,
        adminMessage
      };
    case 'warn_1d':
      return {
        subject: uk ? `${tariff} закінчується завтра` : `${tariff} ends tomorrow`,
        paragraphs: [
          uk
            ? `${tariff}${forSpace} закінчується завтра, ${endsOn}.`
            : `${tariff}${forSpace} ends tomorrow, ${endsOn}.`,
          graceLine(uk, graceUntil),
          ...updaterLine(notice, uk, graceUntil, false)
        ].filter(Boolean),
        action: uk ? 'Відкрити простір' : 'Open the space',
        offerContact: true,
        adminMessage
      };
    case 'grace':
      return {
        subject: uk
          ? `Тариф закінчився — простір працюватиме до ${graceUntil}`
          : `Your plan has ended — the space works until ${graceUntil}`,
        paragraphs: [
          uk
            ? `Тариф закінчився. Простір${team ? ` ${q(team)}` : ''} працюватиме до ${graceUntil}.`
            : `Your plan has ended. The${team ? ` ${q(team)}` : ''} space keeps working until ${graceUntil}.`,
          ...updaterLine(notice, uk, graceUntil, true)
        ],
        action: uk ? 'Відкрити простір' : 'Open the space',
        offerContact: true,
        adminMessage
      };
    case 'blocked':
      return {
        subject: uk
          ? `Простір${team ? ` ${q(team)}` : ''} призупинено`
          : `The${team ? ` ${q(team)}` : ''} space is paused`,
        paragraphs: [
          uk
            ? `Простір призупинено. Тариф закінчився ${endsOn}.`
            : `The space is paused. Your plan ended on ${endsOn}.`,
          uk
            ? 'Усе збережено — файли лишаються на вашому Google Диску, а простір відкриється таким, як був, щойно тариф продовжать.'
            : 'Everything is kept — your files stay on your Google Drive, and the space opens exactly as it was as soon as the plan is extended.'
        ],
        action: uk ? 'Відкрити Soty' : 'Open Soty',
        offerContact: true,
        adminMessage
      };
    case 'granted':
      return {
        subject: uk
          ? `Простір у Soty відкрито до ${endsOn}`
          : `Your Soty space is open through ${endsOn}`,
        paragraphs: [
          uk ? `Простір відкрито до ${endsOn} включно.` : `Your space is open through ${endsOn}.`,
          uk
            ? `Увійдіть у Soty з ${notice.recipientEmail}.`
            : `Sign in to Soty with ${notice.recipientEmail}.`
        ],
        action: uk ? 'Відкрити простір' : 'Open the space',
        offerContact: false,
        adminMessage
      };
    case 'renewed':
      return {
        subject: uk ? `Тариф продовжено до ${endsOn}` : `Your plan is extended through ${endsOn}`,
        paragraphs: [
          uk
            ? `${tariff}${forSpace} продовжено до ${endsOn} включно.`
            : `${tariff}${forSpace} is extended through ${endsOn}.`
        ],
        action: uk ? 'Відкрити простір' : 'Open the space',
        offerContact: false,
        adminMessage
      };
    case 'member_nudge': {
      const member = notice.memberName ?? (uk ? 'Учасник' : 'A member');
      return {
        subject: uk
          ? `${member} просить відновити простір${team ? ` ${q(team)}` : ''}`
          : `${member} asks you to restore${team ? ` the ${q(team)} space` : ' your space'}`,
        paragraphs: [
          uk
            ? `${member} просить відновити доступ до простору${team ? ` ${q(team)}` : ''}.`
            : `${member} asks you to restore access to${team ? ` the ${q(team)} space` : ' your space'}.`,
          uk
            ? 'Простір призупинено, але завдання й файли збережено. Щоб відкрити його знову, продовжте тариф — напишіть адміністратору.'
            : 'The space is paused, but its tasks and files are kept. To open it again, extend the plan — write to the administrator.'
        ],
        action: uk ? 'Відкрити Soty' : 'Open Soty',
        offerContact: true,
        adminMessage
      };
    }
  }
}

function graceLine(uk: boolean, graceUntil: string): string {
  if (!graceUntil) return '';
  return uk
    ? `Після цього простір працюватиме ще до ${graceUntil} включно, а потім буде призупинений.`
    : `After that the space keeps working through ${graceUntil}, then it is paused.`;
}

function updaterLine(
  notice: TariffNotice,
  uk: boolean,
  graceUntil: string,
  afterGrace: boolean
): string[] {
  if (!notice.updaterRunning) return [];
  if (afterGrace) {
    return [uk ? 'Потім оновлення каталогів зупиниться.' : 'Then catalog updates will stop.'];
  }
  return graceUntil
    ? [
        uk
          ? `Після ${graceUntil} оновлення каталогів зупиниться.`
          : `After ${graceUntil} catalog updates will stop.`
      ]
    : [];
}

function mailtoLink(email: string, subject: string, body: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The letter for one claimed notice. Throws only when `siteUrl` cannot be linked to. */
export function buildTariffNoticeEmail(
  notice: TariffNotice,
  context: TariffNoticeContext
): EmailMessage {
  const uk = notice.locale === 'uk';
  const link = teamLink(context.siteUrl);
  const copy = copyFor(notice, context.now);
  const subject = safePlainText(copy.subject).slice(0, 200);
  const greeting = notice.recipientName
    ? uk
      ? `Вітаємо, ${notice.recipientName}!`
      : `Hi ${notice.recipientName},`
    : uk
      ? 'Вітаємо!'
      : 'Hi,';

  const telegram =
    copy.offerContact && notice.contact.telegram ? `https://t.me/${notice.contact.telegram}` : null;
  const mailSubject = uk ? 'Тариф Soty' : 'Soty plan';
  const mail =
    copy.offerContact && notice.contact.email
      ? mailtoLink(notice.contact.email, mailSubject, copy.adminMessage)
      : null;
  const contactLead = uk
    ? 'Продовжити чи додати місця — написати адміністратору:'
    : 'To extend or add seats, write to the administrator:';

  const textLines = [greeting, '', ...copy.paragraphs, '', `${copy.action}: ${link}`];
  if (telegram || mail) {
    textLines.push('', contactLead);
    if (telegram) textLines.push(`Telegram: ${telegram}`);
    if (notice.contact.email && mail) {
      textLines.push(`${uk ? 'Пошта' : 'Email'}: ${notice.contact.email}`);
    }
  }

  const contactItems = [
    telegram ? `<a href="${escapeHtml(telegram)}">Telegram</a>` : null,
    mail && notice.contact.email
      ? `<a href="${escapeHtml(mail)}">${escapeHtml(notice.contact.email)}</a>`
      : null
  ].filter((item): item is string => item !== null);

  const html = `<!doctype html>
<html lang="${uk ? 'uk' : 'en'}">
  <body style="font-family:system-ui,-apple-system,sans-serif;color:#171717;line-height:1.5">
    <p>${escapeHtml(greeting)}</p>
${copy.paragraphs.map(paragraph => `    <p>${escapeHtml(paragraph)}</p>`).join('\n')}
    <p><a href="${escapeHtml(link)}">${escapeHtml(copy.action)}</a></p>${
      contactItems.length > 0
        ? `
    <p>${escapeHtml(contactLead)} ${contactItems.join(' · ')}</p>`
        : ''
    }
  </body>
</html>`;

  return { subject, text: textLines.join('\n'), html };
}
