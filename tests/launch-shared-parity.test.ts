import { describe, expect, it } from 'vitest';
import * as browser from '../packages/shared/src/team/launches';
import * as edge from '../packages/shared/dist/team/launches.js';
import { launchConfig, launchSources } from './fixtures/launches';
describe('Launch browser/Edge parity', () => {
  it('uses identical domain results for every method and bounded campaign counts', () => {
    for (const method of ['other', 'catalog'] as const)
      for (const campaignCount of [1, 2, 3, 4, 5, 100]) {
        const config = launchConfig({ method, campaignCount, maxBudget: 1000 });
        expect(edge.launchPreview(config, launchSources)).toEqual(
          browser.launchPreview(config, launchSources)
        );
      }
  });
  it('matches byte-preserving URL and validation decisions', () => {
    for (const url of [
      'https://example.invalid?sub1=old&sub1=&m={{campaign.id}}#h',
      'https://example.invalid?%73ub1=x&SUB1=y',
      ' https://example.invalid',
      'https://'
    ]) {
      expect(edge.isLaunchUrl(url)).toBe(browser.isLaunchUrl(url));
      if (browser.isLaunchUrl(url))
        expect(edge.patchLaunchUrl(url, { sub1: 'test', sub2: null, sub3: null })).toBe(
          browser.patchLaunchUrl(url, { sub1: 'test', sub2: null, sub3: null })
        );
    }
  });
});
