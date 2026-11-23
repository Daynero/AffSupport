import { useId, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import {
  Button,
  Calendar,
  Popover,
  FormField,
  Select,
  fromCalendarDate,
  toCalendarDate
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { CatalogPublicationSchedule } from './CatalogPublicationSchedule';
import { CatalogTimeZoneSelect } from './CatalogTimeZoneSelect';
import { CatalogTimeInput } from './CatalogTimeInput';
import {
  catalogPublicationFirstDay,
  catalogPublicationTimeRepeats
} from './catalogPublicationDraft';

export interface CatalogPublicationFieldsValue {
  delayed: boolean;
  date: string;
  time: string;
  zone: string;
  occurrence?: 'earlier' | 'later';
}

/** The same compact schedule for a new launch and an existing catalog. */
export function CatalogPublicationFields({
  value,
  onChange,
  disabled,
  media
}: {
  value: CatalogPublicationFieldsValue;
  onChange(value: CatalogPublicationFieldsValue): void;
  disabled: boolean;
  media?: 'video' | 'image';
}) {
  const { t, language } = useI18n();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarAnchor = useRef<HTMLButtonElement>(null);
  const selectedDate = toCalendarDate(value.date);
  const displayedDate = selectedDate
    ? new Intl.DateTimeFormat(language, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC'
      }).format(new Date(`${value.date}T12:00:00Z`))
    : t('catalogPublicationChoose');
  const timeId = useId(),
    zoneId = useId();
  const change = (patch: Partial<CatalogPublicationFieldsValue>) =>
    onChange({ ...value, ...patch });
  return (
    <CatalogPublicationSchedule
      media={media}
      enabled={value.delayed}
      disabled={disabled}
      date={value.date}
      time={value.time}
      zone={value.zone}
      onChange={(delayed, date, time) => change({ delayed, date, time, occurrence: undefined })}
    >
      <FormField label={t('catalogPublicationDay')}>
        <Button
          ref={calendarAnchor}
          variant="outline"
          color="neutral"
          disabled={disabled}
          aria-label={`${t('catalogPublicationDate')}: ${displayedDate}`}
          aria-haspopup="dialog"
          aria-expanded={calendarOpen && !disabled}
          onClick={() => setCalendarOpen(open => !open)}
        >
          <CalendarDays size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {displayedDate}
        </Button>
        <Popover
          open={calendarOpen && !disabled}
          onClose={() => {
            setCalendarOpen(false);
            calendarAnchor.current?.focus();
          }}
          anchor={calendarAnchor}
          placement="bottom-start"
          className="ui-calendar-popover"
          initialFocus='[role="grid"] [tabindex="0"]'
          label={t('catalogPublicationDate')}
          frequent
        >
          <Calendar
            label={t('catalogPublicationDate')}
            value={selectedDate}
            minValue={catalogPublicationFirstDay(value.zone)}
            isDisabled={disabled}
            onChange={date => {
              change({ date: fromCalendarDate(date) ?? '', occurrence: undefined });
              setCalendarOpen(false);
              calendarAnchor.current?.focus();
            }}
          />
        </Popover>
      </FormField>
      <FormField label={t('catalogScheduleTime')} htmlFor={timeId}>
        <CatalogTimeInput
          id={timeId}
          disabled={disabled}
          value={value.time}
          onChange={time => change({ time, occurrence: undefined })}
        />
      </FormField>
      <FormField label={t('catalogPublicationZone')} htmlFor={zoneId}>
        <CatalogTimeZoneSelect
          id={zoneId}
          disabled={disabled}
          value={value.zone}
          date={value.date}
          time={value.time}
          onChange={zone => change({ zone, occurrence: undefined })}
        />
      </FormField>
      {catalogPublicationTimeRepeats(`${value.date}T${value.time}`, value.zone) && (
        <FormField label={t('catalogPublicationOccurrence')}>
          {/* An empty value renders the placeholder; listing '' as an option left
        the trigger blank with no label (seen on beta, 1.4.2). */}
          <Select
            aria-label={t('catalogPublicationOccurrence')}
            disabled={disabled}
            value={value.occurrence ?? ''}
            placeholder={t('catalogPublicationChoose')}
            onChange={occurrence =>
              change({
                occurrence:
                  occurrence === 'earlier' || occurrence === 'later' ? occurrence : undefined
              })
            }
            options={[
              { value: 'earlier', label: t('catalogPublicationEarlier') },
              { value: 'later', label: t('catalogPublicationLater') }
            ]}
          />
        </FormField>
      )}
    </CatalogPublicationSchedule>
  );
}
