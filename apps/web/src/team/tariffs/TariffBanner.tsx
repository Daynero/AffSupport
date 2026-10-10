import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock, X } from 'lucide-react';
import type { SpaceAccessBanner } from '@video-compressor/shared';
import { spaceTariffApi } from '../../api/team';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useToasts } from '../../components/toast';
import { Alert, IconButton } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { ContactAdminButton } from './ContactAdminButton';
import { formatTariffDay, planName } from './format';
import { useOptionalSpaceAccess } from './useSpaceAccess';

/**
 * The term is running out (034, US5.1–5.3).
 *
 * Shown to the owner only — the server decides that, and sends a banner for
 * the space whose term ends soonest, never for a space the old rule still
 * holds open. Three days out it can be put away until tomorrow; the last day
 * and the three days after the term cannot be, because by then the space
 * stopping is close enough to be the most important thing on the screen.
 *
 * Never "0 days": the last day says so, and the day before says "tomorrow".
 */

const DISMISS_KEY = 'soty.tariff-banner.dismissed.v1';

function kyivToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
}

function dismissKey(banner: SpaceAccessBanner): string {
  return `${banner.teamId}:${banner.endsOn}`;
}

function readDismissed(banner: SpaceAccessBanner): boolean {
  try {
    const stored = JSON.parse(window.localStorage.getItem(DISMISS_KEY) ?? '{}') as Record<
      string,
      string
    >;
    return stored[dismissKey(banner)] === kyivToday();
  } catch {
    return false;
  }
}

function writeDismissed(banner: SpaceAccessBanner): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify({ [dismissKey(banner)]: kyivToday() }));
  } catch {
    // A private window: the banner simply comes back on the next visit.
  }
}

function bannerCopy(banner: SpaceAccessBanner): { key: TranslationKey; dated: boolean } {
  if (banner.kind === 'grace') return { key: 'tariffBannerGrace', dated: true };
  if (banner.daysLeft <= 0) return { key: 'tariffBannerLastDay', dated: false };
  if (banner.daysLeft === 1) return { key: 'tariffBannerTomorrow', dated: true };
  return { key: 'tariffBannerEnds', dated: true };
}

export function TariffBanner({ teamId }: { teamId: string }) {
  const { t, language } = useI18n();
  const auth = useOptionalAuth();
  const spaceAccess = useOptionalSpaceAccess();
  const access = spaceAccess?.access ?? null;
  const banner = access?.banner && access.banner.teamId === teamId ? access.banner : null;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(banner ? banner.kind === 'warn_3d' && readDismissed(banner) : false);
  }, [banner]);

  if (!banner || dismissed) return null;

  const team = access?.teams.find(item => item.teamId === teamId) ?? null;
  const plan = planName(team?.tariff ?? null, language) || banner.planCode;
  const email = access?.showcase?.email || auth?.user?.email || '';
  const copy = bannerCopy(banner);
  const date = formatTariffDay(
    banner.kind === 'grace' ? banner.graceUntil : banner.endsOn,
    language
  );
  const text = [
    t(copy.key, copy.dated ? { date } : {}),
    banner.updaterRunning ? t('tariffBannerUpdaterStops') : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Alert
      className="tariff-banner"
      color={banner.kind === 'grace' ? 'error' : 'warning'}
      icon={
        banner.kind === 'grace' ? (
          <AlertTriangle size={ICON_SIZE} strokeWidth={ICON_STROKE} />
        ) : (
          <Clock size={ICON_SIZE} strokeWidth={ICON_STROKE} />
        )
      }
      action={
        <div className="flex items-center gap-1">
          <ContactAdminButton
            contact={access?.showcase?.contact}
            message={t('tariffMessageRenew', { plan, email })}
            subject={t('tariffMessageSubject')}
            label={t('tariffBannerRenew')}
            size="sm"
            icon={false}
            color="neutral"
            variant="outline"
          />
          {banner.kind === 'warn_3d' && (
            <IconButton
              label={t('tariffBannerHide')}
              size="sm"
              onClick={() => {
                writeDismissed(banner);
                setDismissed(true);
              }}
            >
              <X size={ICON_SIZE} strokeWidth={ICON_STROKE} />
            </IconButton>
          )}
        </div>
      }
    >
      {text}
    </Alert>
  );
}

/**
 * «Тариф продовжено до 12 грудня» — once (US5.5).
 *
 * The server keeps the event until it is acknowledged, so the toast is shown
 * once per renewal across every tab and device, not once per page load.
 */
export function TariffToastNotice({
  ack = eventId => spaceTariffApi.ackToast(eventId)
}: {
  ack?: (eventId: string) => Promise<boolean>;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const spaceAccess = useOptionalSpaceAccess();
  const toast = spaceAccess?.access?.toast ?? null;
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (!toast || shown.current.has(toast.eventId)) return;
    shown.current.add(toast.eventId);
    push({
      tone: 'success',
      text: t(toast.kind === 'granted' ? 'tariffToastGranted' : 'tariffToastRenewed', {
        date: formatTariffDay(toast.endsOn, language)
      })
    });
    void ack(toast.eventId).catch(() => undefined);
  }, [ack, language, push, t, toast]);

  return null;
}
