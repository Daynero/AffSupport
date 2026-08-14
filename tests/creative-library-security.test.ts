import { describe, expect, it } from 'vitest';
import {
  CREATIVE_LIBRARY_FORBIDDEN_FIELDS,
  parseCreativeLibraryContribution,
  sanitizeTeamAnalyticsProperties
} from '../packages/shared/src/types';
import { redactForLog, sanitizeErrorDetails } from '../supabase/functions/_shared/errors';

describe('Creative Library privacy contract', () => {
  it('has no storage shape for content-bearing contribution properties', () => {
    for (const key of CREATIVE_LIBRARY_FORBIDDEN_FIELDS) {
      expect(
        parseCreativeLibraryContribution({
          category: 'local_processing',
          action: 'transcription',
          outcome: 'success',
          [key]: 'private-value'
        })
      ).toBeNull();
    }
  });

  it('redacts share, lease, transcript, path, provider and material payloads', () => {
    const unsafe = {
      shareUrl: 'https://drive.google.com/file/secret',
      leaseToken: 'lease-token-with-enough-entropy',
      transcript: 'customer words',
      path: '/private/tmp/customer.mp4',
      providerBody: { id: 'drive-secret' },
      safeState: 'reconciling'
    };
    const serialized = JSON.stringify(redactForLog(unsafe));
    expect(serialized).not.toContain('customer words');
    expect(serialized).not.toContain('drive.google.com');
    expect(serialized).not.toContain('/private/tmp');
    expect(serialized).toContain('reconciling');
    expect(sanitizeErrorDetails(unsafe as Record<string, string>)).toEqual({
      safeState: 'reconciling'
    });
  });

  it('keeps analytics content-free when library-shaped values are attempted', () => {
    expect(
      sanitizeTeamAnalyticsProperties({
        outcome: 'success',
        item_count: 10,
        material_id: 'hidden',
        transcript: 'private',
        share_url: 'https://example.test/private'
      })
    ).toEqual({ outcome: 'success', item_count: 10 });
  });
});
