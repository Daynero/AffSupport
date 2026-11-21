import type { ReactNode } from 'react';
import { now } from '@internationalized/date';
import { Switch } from '../../components/ui/index';
import { useI18n } from '../../i18n';
/** Kill switch for deferred video-link publication. 1.4.2 shipped it as false after
 * production lost deferred links; 1.4.3 fixed the causes and turned it back on.
 * While false, no surface offers the switch and launches publish immediately. */
export const CATALOG_DEFERRED_PUBLICATION_AVAILABLE = true;

export function CatalogPublicationSchedule({
  enabled,
  disabled,
  date,
  time,
  zone,
  onChange,
  children,
  media = 'video'
}: {
  /** 062: an image catalog schedules its pictures, not a video link. */
  media?: 'video' | 'image';
  enabled: boolean;
  disabled: boolean;
  date: string;
  time: string;
  zone: string;
  onChange(enabled: boolean, date: string, time: string): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (!CATALOG_DEFERRED_PUBLICATION_AVAILABLE) return null;
  return (
    <>
      <Switch
        label={t(
          media === 'image' ? 'catalogPublicationDelayedImages' : 'catalogPublicationDelayed'
        )}
        checked={enabled}
        disabled={disabled}
        onChange={enabled => {
          let nextDate = date,
            nextTime = time;
          if (enabled && !date) {
            const next = now(zone || 'Europe/Kyiv').add({ hours: 1 });
            nextDate = `${next.year}-${String(next.month).padStart(2, '0')}-${String(next.day).padStart(2, '0')}`;
            nextTime = `${String(next.hour).padStart(2, '0')}:${String(next.minute).padStart(2, '0')}`;
          }
          onChange(enabled, nextDate, nextTime);
        }}
      />
      {enabled && (
        <div
          className="catalog-publication-controls"
          role="group"
          aria-label={t('catalogPublicationDate')}
        >
          {children}
        </div>
      )}
    </>
  );
}
