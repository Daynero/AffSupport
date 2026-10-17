import { describe, expect, it } from 'vitest';
import {
  patchLaunchUrl,
  normalizeLaunchSub,
  isLaunchUrl,
  missingLaunchSubSlots
} from '../packages/shared/src/team/launches.js';
describe('lossless Launch URL', () => {
  it('changes only literal SUB values, retains duplicates and macros', () => {
    const original =
      'https://example.invalid/p?x=a%2fb+z&sub1=old&sub1=older&%73ub1=x&SUB1=y&p={{campaign.id}}#H';
    expect(patchLaunchUrl(original, { sub1: 'patrik', sub2: null, sub3: null })).toBe(
      'https://example.invalid/p?x=a%2fb+z&sub1=patrik&sub1=patrik&%73ub1=x&SUB1=y&p={{campaign.id}}#H'
    );
  });
  it('preserves absent SUB parameters and patches only parameters already present', () => {
    const original = 'https://example.invalid/?sub1=&sub2&x={{campaign.id}}#h';
    expect(patchLaunchUrl(original, { sub1: null, sub2: null, sub3: null })).toBe(original);
    expect(
      patchLaunchUrl('https://example.invalid/p#H', { sub1: null, sub2: null, sub3: 'video_5' })
    ).toBe('https://example.invalid/p#H');
    expect(
      patchLaunchUrl('https://example.invalid/?sub1&x=1', {
        sub1: 'patrik',
        sub2: null,
        sub3: null
      })
    ).toBe('https://example.invalid/?sub1=patrik&x=1');
  });
  it('retains empty separators and unrelated Unicode', () => {
    expect(
      patchLaunchUrl('https://example.invalid/тест?x=%20&&#H', {
        sub1: 'p',
        sub2: null,
        sub3: null
      })
    ).toBe('https://example.invalid/тест?x=%20&&#H');
  });
  it('reports each missing SUB slot without treating unrelated or encoded keys as present', () => {
    expect(missingLaunchSubSlots('https://example.invalid/')).toEqual(['sub1', 'sub2', 'sub3']);
    expect(missingLaunchSubSlots('https://example.invalid/?sub2=x&%73ub3=y&SUB1=z')).toEqual([
      'sub1',
      'sub3'
    ]);
    expect(missingLaunchSubSlots('not a URL')).toEqual([]);
  });
  it('blocks unsafe source text without transliteration', () => {
    expect(normalizeLaunchSub(' roman test ')).toBe('roman_test');
    for (const s of ['Відео', 'a%20b', 'a\nb', 'a\tb', '😀', ''])
      expect(normalizeLaunchSub(s)).toBeNull();
    expect(() =>
      patchLaunchUrl('https://example.invalid', { sub1: 'a&token=x', sub2: null, sub3: null })
    ).toThrow();
  });
  it('validates without changing the original URL', () => {
    for (const s of [
      ' https://example.invalid',
      'ftp://example.invalid',
      'https:example.invalid',
      'https:///example.invalid',
      'https://example.invalid/\\path',
      'https://user:pw@example.invalid',
      'https://example.invalid/a b'
    ])
      expect(isLaunchUrl(s)).toBe(false);
    expect(isLaunchUrl('https://example.invalid?m={{campaign.id}}')).toBe(true);
  });
});

it('rejects absent hosts, control characters, and oversized URLs', () => {
  for (const url of [
    'https://',
    'https:///',
    'https://example.invalid/\nsecret',
    'https://example.invalid/' + 'a'.repeat(8192)
  ])
    expect(isLaunchUrl(url)).toBe(false);
});
it('always starts a fresh calculation from the unchanged original', () => {
  const original = 'https://example.invalid/?sub1=old&token=x%2fy&sub3=keep#fragment';
  const first = patchLaunchUrl(original, { sub1: 'buyer1', sub2: null, sub3: null });
  const second = patchLaunchUrl(original, { sub1: 'buyer2', sub2: null, sub3: null });
  expect(first).not.toBe(second);
  expect(second).toBe('https://example.invalid/?sub1=buyer2&token=x%2fy&sub3=keep#fragment');
  expect(original).toBe('https://example.invalid/?sub1=old&token=x%2fy&sub3=keep#fragment');
});

it('recognizes underscored SUB slots and patches them without changing spelling or tracking bytes', () => {
  const original =
    'https://example.invalid/?cuuid=fixture-id&fb_pixel=123&sub_2=old&fb_capi_token=synthetic%2Bkeep&fb_campaign_id={{campaign.id}}&sub_3=000&fb_ad_name={{ad.name}}&sub_1=old#fragment';
  expect(missingLaunchSubSlots(original)).toEqual([]);
  expect(patchLaunchUrl(original, { sub1: 'buyer', sub2: 'g1-910-v6', sub3: 'creative' })).toBe(
    'https://example.invalid/?cuuid=fixture-id&fb_pixel=123&sub_2=g1-910-v6&fb_capi_token=synthetic%2Bkeep&fb_campaign_id={{campaign.id}}&sub_3=creative&fb_ad_name={{ad.name}}&sub_1=buyer#fragment'
  );
});
it('updates every literal alias and duplicate while leaving unset slots and unknown keys untouched', () => {
  const original =
    'https://example.invalid/?sub_1=a&sub1=b&sub_1=c&sub_2=keep&sub_3&sub_4=other&SUB_1=upper&%73ub_1=encoded';
  expect(missingLaunchSubSlots(original)).toEqual([]);
  expect(patchLaunchUrl(original, { sub1: 'new', sub2: null, sub3: 'v5' })).toBe(
    'https://example.invalid/?sub_1=new&sub1=new&sub_1=new&sub_2=keep&sub_3=v5&sub_4=other&SUB_1=upper&%73ub_1=encoded'
  );
  expect(missingLaunchSubSlots('https://example.invalid/?sub_2=x')).toEqual(['sub1', 'sub3']);
});
it('never treats a question mark inside the fragment as a SUB query', () => {
  const original = 'https://example.invalid/#fragment?sub_1=x&sub_2=y&sub_3=z';
  expect(missingLaunchSubSlots(original)).toEqual(['sub1', 'sub2', 'sub3']);
  expect(patchLaunchUrl(original, { sub1: 'new', sub2: 'new', sub3: 'new' })).toBe(original);
});
