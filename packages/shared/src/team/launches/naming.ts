import type { LaunchConfig, LaunchCampaign, LaunchSources } from '../launches.js';
export const LAUNCH_NAME_VERSION = 1;
export function isLaunchDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1000 || y > 9999) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export function isLaunchTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
/**
 * Legacy IANA names some browsers still report for the browser's own zone. They name the
 * same clock, but a draft spelled with one and its copy spelled with the other read as
 * different settings; every launch-side default goes through the canonical name.
 */
const LEGACY_LAUNCH_TIMEZONES: Readonly<Record<string, string>> = {
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon'
};
export function canonicalLaunchTimezone(value: string): string {
  const canonical = LEGACY_LAUNCH_TIMEZONES[value];
  return canonical && isLaunchTimezone(canonical) ? canonical : value;
}
/** The browser's zone under its canonical name, for every launch default. */
export function launchBrowserTimezone(): string {
  return canonicalLaunchTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}
export function launchTomorrow(
  now: Date = new Date(),
  timezone: string = launchBrowserTimezone()
): string {
  if (!isLaunchTimezone(timezone) || !Number.isFinite(now.getTime()))
    throw new Error('INVALID_INPUT');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const date = new Date(Date.UTC(part('year'), part('month') - 1, part('day') + 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
export function launchCampaignName(
  config: Pick<
    LaunchConfig,
    'launchDate' | 'creativeAlias' | 'method' | 'gender' | 'age' | 'advantagePlus'
  >,
  sources: Pick<LaunchSources, 'social' | 'agentId' | 'offer'>,
  campaign: Omit<LaunchCampaign, 'name'>
): string {
  const [, month, day] = config.launchDate.split('-');
  return `[${sources.social}-${sources.agentId.slice(-3)}-${config.creativeAlias}${config.method === 'catalog' ? '-c' : ''}] ${sources.offer} $${campaign.budget} ${config.gender.toLowerCase()}${config.age}+${config.advantagePlus ? ' adv+' : ''} ${day}/${month} #${campaign.ordinal}(${campaign.adStart}-${campaign.adEnd})`;
}
