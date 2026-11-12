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
export function launchTomorrow(
  now: Date = new Date(),
  timezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone
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
