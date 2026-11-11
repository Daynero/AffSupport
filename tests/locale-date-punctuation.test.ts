import { expect, it } from 'vitest';
import { en } from '../apps/web/src/locales/en';
import { uk } from '../apps/web/src/locales/uk';

// 1.4.3 QA: the copy toast read «на 12 лист.. Шукайте» — the short Ukrainian
// month ("лист.") and a year suffix ("2027 р.") already end with a dot, so a
// template must not put its own full stop straight after such a {date}.
const SHORT_OR_YEARED_DATES = [
  'launchesCopyCreatedForDate',
  'tariffBannerTomorrow',
  'tariffBannerGrace',
  'tariffBlockedOwnerBody'
] as const;

it.each(SHORT_OR_YEARED_DATES)('%s never puts a full stop right after the date', key => {
  expect(uk[key]).not.toMatch(/\{date\}\./u);
  expect(en[key]).toContain('{date}');
  expect(uk[key].replace('{date}', '12 лист.')).not.toContain('..');
});
