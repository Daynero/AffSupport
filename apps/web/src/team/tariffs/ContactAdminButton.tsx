import { useRef, useState, type ReactNode } from 'react';
import { Copy, Mail, MessageCircle, Send } from 'lucide-react';
import type { AdminContact, TariffContactChannel } from '@video-compressor/shared';
import {
  Button,
  Link,
  Popover,
  type UiColor,
  type UiSize,
  type UiVariant
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { contactLinks, copyText } from './contactLinks';

/**
 * «Написати адміністратору» (034, US7.2).
 *
 * One button; the choice of where to write lives under it, because the person
 * picks a channel once and the screen should not carry three equal buttons for
 * it. Telegram and mail appear only when the administrator has set them; the
 * copy line is always there, so the button never opens onto nothing.
 *
 * Choosing any of the three is the request (US7.3): `onContact` records it,
 * with no separate "send" step.
 */
export function ContactAdminButton({
  contact,
  message,
  subject,
  label,
  onContact,
  color = 'primary',
  variant = 'solid',
  size = 'md',
  icon = true,
  className,
  directTelegram = false
}: {
  contact: AdminContact | null | undefined;
  /** The text the administrator receives, already in the reader's language. */
  message: string;
  subject: string;
  label?: ReactNode;
  onContact?: (channel: TariffContactChannel) => void;
  color?: UiColor;
  variant?: UiVariant;
  size?: UiSize;
  icon?: boolean;
  className?: string;
  /** Open the prepared Telegram draft directly instead of the channel picker. */
  directTelegram?: boolean;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const links = contactLinks(contact, message, subject);

  const chosen = (channel: TariffContactChannel) => {
    onContact?.(channel);
    setOpen(false);
  };

  const copy = async () => {
    const copied = await copyText(message);
    push({
      tone: copied ? 'success' : 'error',
      text: t(copied ? 'tariffContactCopied' : 'tariffContactCopyFailed')
    });
    chosen('copy');
  };

  return (
    <>
      <Button
        ref={anchor}
        color={color}
        variant={variant}
        size={size}
        className={className}
        aria-haspopup={directTelegram && links.telegram ? undefined : 'dialog'}
        aria-expanded={directTelegram && links.telegram ? undefined : open}
        leading={icon ? <MessageCircle size={ICON_SIZE} strokeWidth={ICON_STROKE} /> : undefined}
        onClick={() => {
          if (directTelegram && links.telegram) {
            window.open(links.telegram, '_blank', 'noopener,noreferrer');
            onContact?.('telegram');
            return;
          }
          setOpen(current => !current);
        }}
      >
        {label ?? t('tariffContactAdmin')}
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-start"
        label={t('tariffContactChoose')}
        className="tariff-contact-popover"
      >
        <div className="flex flex-col gap-1">
          {links.telegram && (
            <Link
              variant="standalone"
              href={links.telegram}
              target="_blank"
              rel="noopener noreferrer"
              leading={<Send size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              onClick={() => chosen('telegram')}
            >
              {t('tariffContactTelegram')}
            </Link>
          )}
          {links.email && (
            <Link
              variant="standalone"
              href={links.email}
              leading={<Mail size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              onClick={() => chosen('email')}
            >
              {t('tariffContactEmail')}
            </Link>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            leading={<Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            onClick={() => void copy()}
          >
            {t('tariffContactCopy')}
          </Button>
        </div>
        <p className="tariff-contact-message text-caption text-ink-muted prose">{message}</p>
      </Popover>
    </>
  );
}
