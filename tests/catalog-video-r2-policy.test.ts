import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { en } from '../apps/web/src/locales/en';
import { uk } from '../apps/web/src/locales/uk';
import { handleCatalogVideoR2 } from '../supabase/functions/catalog-video-r2/handler';

/**
 * US5: the published policy, the terms and the sentence beside the checkbox say
 * the same thing, and the feature stays hidden until the owner confirms the
 * policy in the server configuration (FR-018, SC-008).
 */
const legal = readFileSync('apps/web/src/pages/legal-content.ts', 'utf8');

describe('catalog video R2 policy and terms', () => {
  it('names the per-catalog video exception in both languages, next to the picture exception', () => {
    for (const phrase of [
      'Copy the video to R2',
      'copied from Google Drive to Cloudflare R2',
      'opaque public address',
      'only the active version is kept',
      'Копіювати відео в R2',
      'копіюється з Google Drive у Cloudflare R2',
      'непрозорою публічною адресою',
      'зберігається лише активна версія'
    ])
      expect(legal, phrase).toContain(phrase);
    // The blanket wording stays: the exception is scoped, not a loophole.
    expect(legal).toContain('Private media files and thumbnails are not stored on Soty servers');
    expect(legal).toContain('A catalog video is a second, per-catalog exception');
    expect(legal).toContain('Другий виняток, окремо для кожного каталогу');
  });

  it('keeps the checkbox explanation in step with the policy', () => {
    expect(en.catalogVideoR2Toggle).toBe('Copy the video to R2');
    expect(en.catalogVideoR2Explain).toMatch(/Cloudflare R2/u);
    expect(en.catalogVideoR2Explain).toMatch(/Only the active version is kept/u);
    expect(en.catalogVideoR2Explain).toMatch(/opaque address/u);
    expect(uk.catalogVideoR2Toggle).toBe('Копіювати відео в R2');
    expect(uk.catalogVideoR2Explain).toMatch(/Cloudflare R2/u);
    expect(uk.catalogVideoR2Explain).toMatch(/лише активна версія/u);
    expect(uk.catalogVideoR2Explain).toMatch(/непрозорою адресою/u);
  });

  it('answers POLICY_PENDING until the owner confirms the policy, even with the runtime configured', async () => {
    const response = await handleCatalogVideoR2(
      new Request('https://p.supabase.co/functions/v1/catalog-video-r2/availability?teamId=50000000-0000-4000-8000-000000000701', {
        headers: { authorization: 'Bearer user' }
      }),
      {
        service: {
          rpc: async () => ({
            data: { available: false, reason: 'VIDEO_R2_POLICY_PENDING', canManage: true, contractVersion: 1 },
            error: null
          })
        },
        authorize: async () => '50000000-0000-4000-8000-000000000702',
        authorizeWorker: async () => {},
        runWorker: async () => ({}),
        enabled: true,
        configuredOrigin: 'https://videos.test',
        siteUrl: 'https://app.test'
      }
    );
    expect(await response.json()).toEqual({
      ok: true,
      value: { available: false, reason: 'VIDEO_R2_POLICY_PENDING', canManage: true, contractVersion: 1 }
    });
  });
});
