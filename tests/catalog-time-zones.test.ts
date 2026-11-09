import { expect, it } from 'vitest';
import {
  catalogTimeZoneLabel,
  catalogTimeZoneOptions
} from '../apps/web/src/team/product-catalog/catalogTimeZones';
import { translate } from '../apps/web/src/i18n';
const t = (key: Parameters<typeof translate>[1]) => translate('uk', key);
it('labels the chosen city with the offset on the scheduled date, including DST and fractional hours', () => {
  expect(catalogTimeZoneLabel('Europe/Kyiv', '2026-01-15T12:00', t)).toBe('Київ — GMT+02:00');
  expect(catalogTimeZoneLabel('Europe/Kyiv', '2026-07-15T12:00', t)).toBe('Київ — GMT+03:00');
  expect(catalogTimeZoneLabel('Asia/Kolkata', '2026-07-15T12:00', t)).toBe('Колката — GMT+05:30');
});
it('preserves saved zone aliases and offers no empty or invalid selection', () => {
  const options = catalogTimeZoneOptions('Europe/Kiev', '2026-01-15T12:00', t);
  expect(options[0]).toEqual({ value: 'Europe/Kiev', label: 'Київ — GMT+02:00' });
  expect(options.some(option => !option.value)).toBe(false);
  expect(catalogTimeZoneOptions('invalid', '', t).some(option => option.value === 'invalid')).toBe(
    false
  );
});
