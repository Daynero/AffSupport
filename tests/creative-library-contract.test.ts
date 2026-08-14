import { describe, expect, it } from 'vitest';
import {
  LIBRARY_ATTACH_MUTATION_BATCH_MAX,
  LIBRARY_JOB_KINDS,
  LIBRARY_JOB_LEASE_SECONDS,
  LIBRARY_STAGES,
  MATERIAL_CATEGORIES,
  TEAM_ERROR_CODES,
  applyTaskProgressPatch,
  localTaskDayBounds,
  parseCreativeLibraryContribution,
  parseLibraryJobClaim,
  parseLibraryJobHeartbeat,
  parseLibraryPlacement,
  parseLibraryShareCopyRequest,
  parseTaskAttachmentMutation,
  parseTeamTaskPatch,
  parseUploadBatchRequest
} from '../packages/shared/src/types';

const teamId = '11111111-1111-4111-8111-111111111111';
const materialId = '22222222-2222-4222-8222-222222222222';

describe('Creative Library shared contract', () => {
  it('normalizes only the four canonical placement values', () => {
    expect(LIBRARY_STAGES).toEqual(['finds', 'library']);
    expect(
      parseLibraryPlacement({ stage: 'library', offer: '  Nutra  ', language: 'uk', type: 'Video' })
    ).toEqual({ stage: 'library', offer: 'Nutra', language: 'uk', type: 'Video' });
    expect(
      parseLibraryPlacement({ stage: 'archive', offer: 'x', language: 'uk', type: 'video' })
    ).toBeNull();
  });

  it('locks the closed six-value material category set and its Type folder labels', () => {
    // Parity guard (FR-004a): this must match the SQL `team_materials_category_check`
    // (`video|image|archive|transcript|landing|other`) in
    // supabase/migrations/20260801092000_drive_vault_catalog.sql. The Type folder segment is
    // `initcap(category)` server-side, or `Unknown` when an asset cannot be classified.
    expect([...MATERIAL_CATEGORIES]).toEqual([
      'video',
      'image',
      'archive',
      'transcript',
      'landing',
      'other'
    ]);
    const typeLabel = (category: string | null) =>
      category ? category[0].toUpperCase() + category.slice(1) : 'Unknown';
    expect(MATERIAL_CATEGORIES.map(typeLabel)).toEqual([
      'Video',
      'Image',
      'Archive',
      'Transcript',
      'Landing',
      'Other'
    ]);
    expect(typeLabel(null)).toBe('Unknown');
  });

  it('accepts a 100-item batch, deduplicates client keys, and preserves manual language', () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      clientItemKey: `item-${index}`,
      name: `asset-${index}.mp4`,
      mimeType: 'video/mp4',
      sizeBytes: index + 1
    }));
    const parsed = parseUploadBatchRequest({
      teamId,
      stage: 'finds',
      offer: 'Offer A',
      geo: 'UA',
      languageMode: 'manual',
      language: 'uk',
      items
    });
    expect(parsed?.items).toHaveLength(100);
    expect(parsed?.language).toBe('uk');
    expect(parseUploadBatchRequest({ ...parsed, items: [...items, items[0]] })).toBeNull();
  });

  it('parses operation-scoped claims and heartbeats with a bounded lease', () => {
    expect(LIBRARY_JOB_KINDS).toEqual(['transcription', 'translation', 'landing_optimization']);
    expect(LIBRARY_JOB_LEASE_SECONDS).toBeLessThanOrEqual(120);
    expect(
      parseLibraryJobClaim({
        teamId,
        agentInstanceId: materialId,
        supportedKinds: ['transcription'],
        interfaceLanguage: 'uk'
      })
    ).toMatchObject({ teamId, supportedKinds: ['transcription'] });
    expect(
      parseLibraryJobHeartbeat({
        teamId,
        attemptId: materialId,
        agentInstanceId: materialId,
        leaseToken: 'lease-token-with-enough-entropy-123',
        progress: 51,
        stage: 'processing'
      })
    ).toMatchObject({ progress: 51, stage: 'processing' });
  });

  it('keeps task progress manual after the first explicit value and rejects silent clipping', () => {
    expect(
      applyTaskProgressPatch(
        { status: 'todo', progressMax: 9, progressValue: 0, progressManuallySet: false },
        { progressValue: 6 }
      )
    ).toEqual({ status: 'todo', progressMax: 9, progressValue: 6, progressManuallySet: true });
    expect(
      applyTaskProgressPatch(
        { status: 'in_progress', progressMax: 9, progressValue: 6, progressManuallySet: true },
        { status: 'done' }
      )
    ).toMatchObject({ progressValue: 6, progressManuallySet: true });
    expect(() =>
      applyTaskProgressPatch(
        { status: 'todo', progressMax: 9, progressValue: 6, progressManuallySet: true },
        { progressMax: 5 }
      )
    ).toThrow('INVALID_INPUT');
    expect(
      applyTaskProgressPatch(
        { status: 'todo', progressMax: 100, progressValue: 0, progressManuallySet: false },
        { status: 'done' }
      ).progressValue
    ).toBe(100);
  });

  it('parses bounded attachment mutation batches without a semantic task total cap', () => {
    expect(LIBRARY_ATTACH_MUTATION_BATCH_MAX).toBe(100);
    const parsed = parseTaskAttachmentMutation({
      teamId,
      taskId: materialId,
      materialIds: [materialId, materialId]
    });
    expect(parsed?.materialIds).toEqual([materialId]);
    expect(
      parseTaskAttachmentMutation({
        teamId,
        taskId: materialId,
        materialIds: Array.from(
          { length: 101 },
          (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`
        )
      })
    ).toBeNull();
  });

  it('validates task patches and emits half-open local calendar bounds', () => {
    expect(parseTeamTaskPatch({ title: '  Launch task ', status: 'in_progress' })).toEqual({
      title: 'Launch task',
      status: 'in_progress'
    });
    expect(parseTeamTaskPatch({ progressMax: 0 })).toBeNull();
    const bounds = localTaskDayBounds('2026-08-14');
    expect(new Date(bounds.to).getTime() - new Date(bounds.from).getTime()).toBeGreaterThanOrEqual(
      23 * 60 * 60 * 1000
    );
    expect(bounds.from < bounds.to).toBe(true);
  });

  it('requires explicit restricted sharing approval and safe idempotency', () => {
    expect(
      parseLibraryShareCopyRequest({
        teamId,
        materialId,
        allowIfRestricted: true,
        rememberChoice: true,
        idempotencyKey: 'share-copy-12345678'
      })
    ).toMatchObject({ allowIfRestricted: true, rememberChoice: true });
    expect(
      parseLibraryShareCopyRequest({ teamId, materialId, allowIfRestricted: 'yes' })
    ).toBeNull();
  });

  it('keeps contribution records closed and adds stable library error codes', () => {
    expect(
      parseCreativeLibraryContribution({
        category: 'human_activity',
        action: 'task_completed',
        outcome: 'success'
      })
    ).toEqual({ category: 'human_activity', action: 'task_completed', outcome: 'success' });
    expect(
      parseCreativeLibraryContribution({
        category: 'human_activity',
        action: 'task_completed',
        outcome: 'success',
        filename: 'secret.mp4'
      })
    ).toBeNull();
    expect(TEAM_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'STALE_RESULT',
        'GROUP_RECONCILING',
        'LEASE_EXPIRED',
        'ALREADY_COMPLETED',
        'SHARE_NOT_ALLOWED'
      ])
    );
  });
});
