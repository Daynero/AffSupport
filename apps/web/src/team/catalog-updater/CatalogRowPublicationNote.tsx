import { CalendarClock, CircleAlert } from 'lucide-react';
import type { CatalogRowPublication } from '../../api/team';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';

/**
 * «Посилання о 19:42» under a catalog whose video link is scheduled, or «Посилання чекає
 * на відео» once its time has come while the videos are still being made.
 *
 * The manager showed nothing for a deferred link: the time lived only inside
 * «Відкладене відеопосилання», so nobody scanning the list knew a link was due (1.4.3 QA).
 */
export function CatalogRowPublicationNote({
  publication,
  now = Date.now(),
  onOpen
}: {
  publication: CatalogRowPublication;
  now?: number;
  /** Opens the link's window, where a stopped write says why and is sent again (072). */
  onOpen?: () => void;
}) {
  const { t, language } = useI18n();
  // A write that stopped, or whose result is not confirmed, is said in the row (072, П5): the
  // window it opens has the reason and «Опублікувати ще раз».
  const stopped =
    publication.jobState === 'blocked' && publication.blockedReason !== 'legacy_adoption_required';
  if (stopped || publication.jobState === 'unknown')
    return (
      <small className="catalog-row-publication is-stopped" role="status">
        <CircleAlert size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t(stopped ? 'catalogPublicationBlockedGeneric' : 'catalogPublicationVerifyingWrite')}
        {onOpen && (
          <Button size="xs" variant="link" color="warning" onClick={onOpen}>
            {t('catalogUpdaterDetails')}
          </Button>
        )}
      </small>
    );
  if (!publication.dueAt || !publication.timeZone) return null;
  const due = Date.parse(publication.dueAt);
  if (!Number.isFinite(due)) return null;
  let text: string;
  if (publication.waitingForVideos && due <= now) text = t('catalogRowPublicationWaiting');
  else {
    try {
      const zone = publication.timeZone;
      const day = (instant: number) =>
        new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short' }).format(instant);
      const time = new Intl.DateTimeFormat(language, {
        timeStyle: 'short',
        hourCycle: 'h23',
        timeZone: zone
      }).format(due);
      text =
        day(due) === day(now)
          ? t('catalogRowPublicationToday', { time })
          : t('catalogRowPublicationOn', {
              date: new Intl.DateTimeFormat(language, {
                day: 'numeric',
                month: 'short',
                timeZone: zone
              }).format(due),
              time
            });
    } catch {
      return null;
    }
  }
  return (
    <small className="catalog-row-publication" role="status">
      <CalendarClock size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      {text}
    </small>
  );
}
