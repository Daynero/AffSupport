import { CatalogPublicationSchedule } from './CatalogPublicationSchedule';
import { CatalogTimeZoneSelect } from './CatalogTimeZoneSelect';
import { useId } from 'react';
import {
  Calendar,
  FormField,
  Input,
  Select,
  fromCalendarDate,
  toCalendarDate
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { CatalogTimeInput } from './CatalogTimeInput';
import {
  catalogPublicationFirstDay,
  catalogPublicationTimeRepeats
} from './catalogPublicationDraft';
export interface CatalogCreationVideoDraft {
  variationCount: string;
  delayed: boolean;
  date: string;
  time: string;
  zone: string;
  occurrence?: 'earlier' | 'later';
}
export function CatalogCreationVideoFields({
  value,
  onChange,
  restitch,
  productCount,
  disabled
}: {
  value: CatalogCreationVideoDraft;
  onChange(value: CatalogCreationVideoDraft): void;
  restitch: boolean;
  productCount: number;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const countId = useId(),
    timeId = useId(),
    zoneId = useId();
  const change = (patch: Partial<CatalogCreationVideoDraft>) => onChange({ ...value, ...patch });
  const count = Number(value.variationCount);
  const invalid =
    value.variationCount !== '' && (!Number.isInteger(count) || count < 1 || count > productCount);
  return (
    <>
      {restitch && (
        <FormField
          label={t('catalogVideoVariationCount')}
          htmlFor={countId}
          error={invalid ? t('catalogVideoVariationLimit', { count: productCount }) : undefined}
        >
          <Input
            id={countId}
            inputMode="numeric"
            width="narrow"
            value={value.variationCount}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={event =>
              change({ variationCount: event.target.value.replace(/[^\d]/gu, '').slice(0, 3) })
            }
          />
        </FormField>
      )}
      <CatalogPublicationSchedule
        enabled={value.delayed}
        disabled={disabled}
        date={value.date}
        time={value.time}
        zone={value.zone}
        onChange={(delayed, date, time) => change({ delayed, date, time, occurrence: undefined })}
      >
        <Calendar
          label={t('catalogPublicationDate')}
          value={toCalendarDate(value.date)}
          // Past days are shown as unavailable; a busy form freezes the calendar
          // instead of marking every day — and the chosen one — invalid (1.4.3).
          minValue={catalogPublicationFirstDay(value.zone)}
          isDisabled={disabled}
          onChange={date => change({ date: fromCalendarDate(date) ?? '', occurrence: undefined })}
        />
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
        {(value.occurrence !== undefined ||
          catalogPublicationTimeRepeats(`${value.date}T${value.time}`, value.zone)) && (
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
    </>
  );
}
