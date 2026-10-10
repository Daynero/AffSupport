// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamPreviewResult } from '@video-compressor/shared';

/**
 * 033 T008 / FR-009 — opening a team material's preview is one attempt: one
 * `team_preview_started` and one `team_preview_completed` on the same opaque `attempt_id`,
 * with the outcome and how long it took. A failure adds `error_occurred` with the safe code on
 * that attempt; nothing names the material.
 */

const track = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track } }));

const { MaterialPreview } = await import('../apps/web/src/team/preview/MaterialPreview');
type MaterialPreviewClient = NonNullable<Parameters<typeof MaterialPreview>[0]['client']>;

const TEAM_ID = '42000000-0000-4000-8000-000000000001';
const MATERIAL = { id: 'material-secret-id', name: 'secret-offer.mp4', category: 'video' as const };
const ARCHIVE = { id: 'material-archive', name: 'secret-pack.zip', category: 'archive' as const };

function client(
  requestPreview: MaterialPreviewClient['requestPreview'],
  overrides: Partial<MaterialPreviewClient> = {}
): MaterialPreviewClient {
  return {
    requestPreview,
    openAgentArchive: vi.fn(),
    openAgentLanding: vi.fn(),
    closeAgentPreview: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function previewEvents() {
  return track.mock.calls.filter(([name]) =>
    ['team_preview_started', 'team_preview_completed', 'error_occurred'].includes(name as string)
  ) as [string, Record<string, unknown>][];
}

afterEach(() => {
  cleanup();
  track.mockClear();
});

describe('team preview analytics', () => {
  it('records a successful opening as one started and one completed on one attempt', async () => {
    const media: TeamPreviewResult = {
      kind: 'media',
      rangeUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range?grant=opaque',
      mimeType: 'video/mp4',
      expiresAt: '2026-08-01T12:05:00.000Z'
    };
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={MATERIAL}
        client={client(vi.fn().mockResolvedValue(media))}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => expect(document.body.querySelector('video')).not.toBeNull());
    cleanup();

    const events = previewEvents();
    expect(events.map(([name]) => name)).toEqual([
      'team_preview_started',
      'team_preview_completed'
    ]);
    const [[, started], [, completed]] = events;
    expect(started).toMatchObject({ stage: 'previewing', category: 'video' });
    expect(started!.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(completed).toMatchObject({
      attempt_id: started!.attempt_id,
      outcome: 'success',
      category: 'video'
    });
    expect(completed!.duration_ms).toEqual(expect.any(Number));
    expect(JSON.stringify(events)).not.toMatch(/secret|material-/);
  });

  it('records an agent archive opening as a success once the local preview settles', async () => {
    const agent = {
      kind: 'agent',
      previewKind: 'archive',
      operationId: 'op-1',
      transferGrant: { ticket: 'ticket' }
    } as unknown as TeamPreviewResult;
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={ARCHIVE}
        client={client(vi.fn().mockResolvedValue(agent), {
          openAgentArchive: vi.fn().mockResolvedValue({
            kind: 'archive',
            operationId: 'op-1',
            entries: [],
            truncated: false
          })
        })}
        onClose={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(previewEvents().map(([name]) => name)).toEqual([
        'team_preview_started',
        'team_preview_completed'
      ])
    );
    const [[, started], [, completed]] = previewEvents();
    expect(completed).toMatchObject({ attempt_id: started!.attempt_id, outcome: 'success' });
  });

  it('records a failed opening as one started, one completed failure and its safe code', async () => {
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={MATERIAL}
        client={client(vi.fn().mockRejectedValue(new Error('PERMISSION_DENIED')))}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    cleanup();

    const events = previewEvents();
    expect(events.map(([name]) => name)).toEqual([
      'team_preview_started',
      'team_preview_completed',
      'error_occurred'
    ]);
    const [[, started], [, completed], [, error]] = events;
    expect(completed).toMatchObject({ attempt_id: started!.attempt_id, outcome: 'failure' });
    expect(error).toMatchObject({
      attempt_id: started!.attempt_id,
      error_stage: 'library',
      error_code: 'PERMISSION_DENIED',
      error_fingerprint: 'team:library:PERMISSION_DENIED',
      outcome: 'failure'
    });
  });

  it('never sends the text of a failure, and ends an abandoned opening as cancelled', async () => {
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={MATERIAL}
        client={client(vi.fn().mockRejectedValue(new Error('Could not open /Users/a/secret.mov')))}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const error = previewEvents().find(([name]) => name === 'error_occurred')![1];
    expect(error).toMatchObject({ error_code: 'unknown' });
    expect(JSON.stringify(previewEvents())).not.toMatch(/secret|Users/);
    cleanup();
    track.mockClear();

    // Closed while still loading: the attempt ends once, as cancelled.
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={MATERIAL}
        client={client(() => new Promise<TeamPreviewResult>(() => {}))}
        onClose={vi.fn()}
      />
    );
    cleanup();
    const events = previewEvents();
    expect(events.map(([name]) => name)).toEqual([
      'team_preview_started',
      'team_preview_completed'
    ]);
    expect(events[1]![1]).toMatchObject({
      attempt_id: events[0]![1].attempt_id,
      outcome: 'cancelled'
    });
  });
});
