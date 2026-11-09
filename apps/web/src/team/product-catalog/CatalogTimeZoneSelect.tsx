import { useEffect, useMemo } from 'react';
import { Select } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { catalogTimeZoneOptions } from './catalogTimeZones';
export function CatalogTimeZoneSelect({
  id,
  value,
  date,
  time,
  disabled,
  onChange
}: {
  id: string;
  value: string;
  date: string;
  time: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const { t } = useI18n();
  const options = useMemo(
    () => catalogTimeZoneOptions(value, `${date}T${time}`, t),
    [value, date, time, t]
  );
  const selected = options.some(option => option.value === value) ? value : 'Europe/Kyiv';
  useEffect(() => {
    if (value !== selected) onChange(selected);
  }, [value, selected, onChange]);
  return (
    <Select
      id={id}
      aria-label={t('catalogPublicationZone')}
      value={selected}
      disabled={disabled}
      options={options}
      onChange={zone => {
        if (options.some(option => option.value === zone)) onChange(zone);
      }}
    />
  );
}
