import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  parseCreativeLibraryContribution,
  sanitizeTeamAnalyticsProperties
} from '@video-compressor/shared';
import { trackCreativeLibraryContribution } from '../apps/web/src/analytics/service';

describe('Creative Library separate contribution records', () => {
  it('accepts Finds selection only as Human Activity', () => {
    expect(
      parseCreativeLibraryContribution({
        category: 'human_activity',
        action: 'find_selected',
        outcome: 'success'
      })
    ).toEqual({ category: 'human_activity', action: 'find_selected', outcome: 'success' });
    expect(
      parseCreativeLibraryContribution({
        category: 'local_processing',
        action: 'find_selected',
        outcome: 'success'
      })
    ).toBeNull();
  });

  it('emits only allowlisted category/action/outcome counters and no combined score', () => {
    const track = vi.fn();
    expect(
      trackCreativeLibraryContribution(
        'team_library_batch_completed',
        { category: 'human_activity', action: 'find_selected', outcome: 'success' },
        { itemCount: 3, track }
      )
    ).toBe(true);
    expect(track).toHaveBeenCalledWith('team_library_batch_completed', {
      contribution_category: 'human_activity',
      contribution_action: 'find_selected',
      outcome: 'success',
      item_count: 3
    });
    expect(
      sanitizeTeamAnalyticsProperties({
        contribution_category: 'local_processing',
        contribution_action: 'transcription',
        outcome: 'failure',
        combined_score: 99,
        filename: 'private.mp4'
      })
    ).toEqual({
      contribution_category: 'local_processing',
      contribution_action: 'transcription',
      outcome: 'failure'
    });
  });

  it('stores no content payload in the immutable aggregate source schema', () => {
    const foundation = readFileSync(
      new URL(
        '../supabase/migrations/20260814100000_creative_library_foundation.sql',
        import.meta.url
      ),
      'utf8'
    );
    const table = foundation.match(
      /create table public\.team_contribution_records \([\s\S]+?\n\);/u
    )?.[0];
    expect(table).toBeTruthy();
    expect(table).not.toMatch(/transcript_text|filename|path|share_url|payload|combined_score/u);
    expect(table).toMatch(/category text not null/u);
    expect(table).toMatch(/action_kind text not null/u);
  });
});
