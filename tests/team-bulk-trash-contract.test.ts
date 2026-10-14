import { describe, expect, it } from 'vitest';
import {
  parseTeamBulkTrashGroups,
  parseTeamBulkTrashIntent,
  parseTeamBulkTrashRetry
} from '@video-compressor/shared';

const GROUP = 'bb370000-0000-4000-8000-000000000031';
const MATERIAL = 'bb370000-0000-4000-8000-000000000021';
const KEY = 'bb370000-0000-4000-8000-000000000041';

describe('hosted bulk trash contract', () => {
  it('accepts only bounded content-free intent and receipt shapes', () => {
    expect(
      parseTeamBulkTrashIntent({
        id: GROUP,
        requestId: GROUP,
        items: [{ materialId: MATERIAL, idempotencyKey: KEY }]
      })?.items[0]?.idempotencyKey
    ).toBe(KEY);
    expect(
      parseTeamBulkTrashGroups([
        {
          id: GROUP,
          requestId: GROUP,
          createdAt: '2026-10-09T10:00:00Z',
          items: [
            {
              materialId: MATERIAL,
              idempotencyKey: KEY,
              operationId: null,
              state: 'unknown',
              errorCode: null
            }
          ]
        }
      ])?.[0]?.items[0]?.state
    ).toBe('unknown');
    expect(
      parseTeamBulkTrashGroups([
        {
          id: GROUP,
          requestId: GROUP,
          createdAt: '2026-10-09T10:00:00Z',
          items: [
            {
              materialId: MATERIAL,
              idempotencyKey: KEY,
              operationId: null,
              state: 'succeeded',
              errorCode: null
            }
          ]
        }
      ])
    ).toBeNull();
    expect(parseTeamBulkTrashRetry({ status: 'retryable', idempotencyKey: KEY })).toEqual({
      status: 'retryable',
      idempotencyKey: KEY
    });
    expect(
      parseTeamBulkTrashRetry({ status: 'retryable', idempotencyKey: '/private/file' })
    ).toBeNull();
    expect(
      parseTeamBulkTrashIntent({
        id: GROUP,
        requestId: GROUP,
        items: [{ materialId: '/private/file', idempotencyKey: KEY }]
      })
    ).toBeNull();
  });
});
