import { parseDateTime, toZoned } from '@internationalized/date';
import type { TranslationKey } from '../../i18n';
const cities: Record<string, TranslationKey> = {
  'Europe/Kyiv': 'catalogZoneKyiv',
  'Europe/London': 'catalogZoneLondon',
  'Europe/Berlin': 'catalogZoneBerlin',
  'Europe/Paris': 'catalogZoneParis',
  'Europe/Warsaw': 'catalogZoneWarsaw',
  'Europe/Prague': 'catalogZonePrague',
  'Europe/Bucharest': 'catalogZoneBucharest',
  'Europe/Istanbul': 'catalogZoneIstanbul',
  'Asia/Baku': 'catalogZoneBaku',
  'Asia/Tbilisi': 'catalogZoneTbilisi',
  'Asia/Dubai': 'catalogZoneDubai',
  'Asia/Kolkata': 'catalogZoneKolkata',
  'Asia/Bangkok': 'catalogZoneBangkok',
  'Asia/Singapore': 'catalogZoneSingapore',
  'Asia/Tokyo': 'catalogZoneTokyo',
  'Australia/Sydney': 'catalogZoneSydney',
  'America/New_York': 'catalogZoneNewYork',
  'America/Chicago': 'catalogZoneChicago',
  'America/Los_Angeles': 'catalogZoneLosAngeles',
  'America/Sao_Paulo': 'catalogZoneSaoPaulo'
};
export function catalogTimeZoneOptions(
  selected: string,
  localDateTime: string,
  t: (key: TranslationKey) => string,
  now = new Date()
) {
  const supported = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  const zones = new Set([
    'UTC',
    ...Object.keys(cities),
    ...(supported.supportedValuesOf?.('timeZone') ?? []),
    selected
  ]);
  // Keep stored aliases valid without showing Kyiv twice in the normal list.
  if (selected !== 'Europe/Kiev') zones.delete('Europe/Kiev');
  return [...zones]
    .filter(Boolean)
    .flatMap(zone => {
      try {
        return [{ value: zone, label: catalogTimeZoneLabel(zone, localDateTime, t, now) }];
      } catch {
        return [];
      }
    })
    .sort((a, b) =>
      a.value === selected ? -1 : b.value === selected ? 1 : a.label.localeCompare(b.label)
    );
}

export function catalogTimeZoneLabel(
  zone: string,
  localDateTime: string,
  t: (key: TranslationKey) => string,
  now = new Date()
) {
  let instant = now;
  try {
    instant = toZoned(parseDateTime(localDateTime), zone).toDate();
  } catch {
    /* Incomplete date: show today's offset. */
  }
  const offset =
    new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(instant)
      .find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
  return `${catalogTimeZoneCity(zone, t)} — ${offset === 'GMT' ? 'GMT+00:00' : offset}`;
}

/** A zone as a person names it — "Kyiv", not `Europe/Kiev`. */
export function catalogTimeZoneCity(zone: string, t: (key: TranslationKey) => string): string {
  const key = cities[zone === 'Europe/Kiev' ? 'Europe/Kyiv' : zone];
  return key ? t(key) : zone.split('/').slice(1).join(' / ').replaceAll('_', ' ') || zone;
}
