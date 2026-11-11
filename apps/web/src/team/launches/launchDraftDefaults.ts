import { launchTomorrow, type LaunchDraft } from '@video-compressor/shared';
import { newLaunchCatalogConfig } from './launchCatalogDefaults';

export function newLaunchDraft(): LaunchDraft {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    schemaVersion: 1,
    campaignCount: 3,
    maxBudget: 30,
    minBudget: 10,
    adsCount: 3,
    budgetMode: 'auto',
    budgets: null,
    // The usual minimum on Meta; an empty field read as a missing value nobody had chosen.
    age: 18,
    gender: 'M',
    advantagePlus: true,
    launchDate: launchTomorrow(new Date(), timezone),
    timezone,
    method: 'other',
    subConfig: {
      schemaVersion: 1,
      sub1: ['buyer'],
      sub2: ['social', 'adAccountSuffix', 'creative'],
      sub3: ['creative']
    },
    catalog: newLaunchCatalogConfig()
  };
}
