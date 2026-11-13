import { useId, useState, type ReactNode } from 'react';
import { now } from '@internationalized/date';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Switch } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { catalogTimeZoneLabel } from './catalogTimeZones';
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
  forceOpen = false
}: {
  enabled: boolean;
  disabled: boolean;
  date: string;
  time: string;
  zone: string;
  onChange(enabled: boolean, date: string, time: string): void;
  children: ReactNode;
  /** Reveal an invalid schedule when its host form is submitted. */
  forceOpen?: boolean;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (!CATALOG_DEFERRED_PUBLICATION_AVAILABLE) return null;
  let summary = t('catalogPublicationChoose');
  try {
    if (date) {
      const dateLabel = new Intl.DateTimeFormat(language, {
        dateStyle: 'medium',
        timeZone: 'UTC'
      }).format(new Date(`${date}T12:00:00Z`));
      const zoneLabel = catalogTimeZoneLabel(zone, `${date}T${time}`, t);
      summary = `${dateLabel}, ${time} · ${zoneLabel}`;
    }
  } catch {
    /* Incomplete drafts remain editable. */
  }
  return (
    <>
      <Switch
        label={t('catalogPublicationDelayed')}
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
          setOpen(false);
          onChange(enabled, nextDate, nextTime);
        }}
      />
      {enabled && (
        <section className="settings-panel catalog-publication-schedule">
          <button
            type="button"
            className="settings-collapse section-heading compact-heading"
            aria-expanded={open || forceOpen}
            aria-controls={bodyId}
            onClick={() => setOpen(value => !value)}
          >
            <CalendarDays size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="catalog-publication-label">{t('catalogPublicationDate')}</span>
            <span className="settings-summary catalog-publication-when" title={summary}>
              {summary}
            </span>
            <ChevronDown
              size={ICON_SIZE}
              strokeWidth={ICON_STROKE}
              className={`settings-chevron ${open || forceOpen ? '' : 'is-rotated'}`}
              aria-hidden="true"
            />
          </button>
          <div id={bodyId} className="catalog-publication-controls" hidden={!open && !forceOpen}>
            {children}
          </div>
        </section>
      )}
    </>
  );
}
