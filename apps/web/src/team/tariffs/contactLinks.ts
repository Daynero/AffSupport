import { normalizeTelegramLogin, type AdminContact } from '@video-compressor/shared';

/**
 * Writing to the administrator (034, US7.2, FR-019).
 *
 * Three ways, one message: a Telegram chat opened with the text already typed,
 * a mail with its subject and body, or the text on the clipboard for anywhere
 * else. The contact is structured on the server — a login and an address, each
 * validated there — and validated again here, because a link is built from it
 * and an unchecked login is a way to point the button somewhere else.
 */

export interface ContactLinks {
  telegram: string | null;
  email: string | null;
}

export function telegramLink(login: string | null, message: string): string | null {
  const valid = normalizeTelegramLogin(login);
  if (!valid) return null;
  return `https://t.me/${valid}?text=${encodeURIComponent(message)}`;
}

export function mailLink(address: string | null, subject: string, body: string): string | null {
  if (!address || !/^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/u.test(address)) return null;
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function contactLinks(
  contact: AdminContact | null | undefined,
  message: string,
  subject: string
): ContactLinks {
  return {
    telegram: telegramLink(contact?.telegram ?? null, message),
    email: mailLink(contact?.email ?? null, subject, message)
  };
}

/** Copies text, falling back to a hidden field where the clipboard API is refused. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the older path: an insecure origin or a denied permission.
  }
  try {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  } catch {
    return false;
  }
}
