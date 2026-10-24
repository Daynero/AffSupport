export function campaignCountLabel(language: string, count: number): string {
  if (language !== 'uk') return count === 1 ? 'campaign' : 'campaigns';
  const category = pluralRules('uk').select(count);
  return category === 'one' ? 'кампанія' : category === 'few' ? 'кампанії' : 'кампаній';
}
import { pluralRules } from '../../lib/plural-rules';
