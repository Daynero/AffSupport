// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogMaterialItem, TeamPreviewResult } from '@video-compressor/shared';
import {
  MaterialPreview,
  type MaterialPreviewClient
} from '../apps/web/src/team/preview/MaterialPreview';

const TEAM_ID = '42000000-0000-4000-8000-000000000001';

function item(
  category: CatalogMaterialItem['category'],
  overrides: Partial<CatalogMaterialItem> = {}
): CatalogMaterialItem {
  return {
    id: `material-${category}`,
    teamId: TEAM_ID,
    name: `creative.${category === 'video' ? 'mp4' : category === 'image' ? 'png' : 'txt'}`,
    kind: 'file',
    category,
    mimeType:
      category === 'video' ? 'video/mp4' : category === 'image' ? 'image/png' : 'text/plain',
    fileExtension: category === 'video' ? 'mp4' : category === 'image' ? 'png' : 'txt',
    classificationVersion: 1,
    classificationSource: 'mime',
    sizeBytes: 1024,
    modifiedAt: '2026-08-01T12:00:00.000Z',
    geo: null,
    language: null,
    offer: null,
    tags: [],
    transcriptIngestState: category === 'transcript' ? 'full' : 'not_applicable',
    transcriptTruncated: false,
    previewState: 'ready',
    lineage: { hasSource: false, hasDerivatives: false, isVersion: false },
    ...overrides
  };
}

function client(result: TeamPreviewResult): MaterialPreviewClient {
  return {
    requestPreview: vi.fn().mockResolvedValue(result),
    openAgentArchive: vi.fn(),
    openAgentLanding: vi.fn(),
    closeAgentPreview: vi.fn().mockResolvedValue(undefined)
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('team material preview UI', () => {
  it.each([
    ['video', 'video'],
    ['image', 'img']
  ] as const)('renders bounded %s playback with no-referrer URLs', async (category, tag) => {
    const previewClient = client({
      kind: 'media',
      rangeUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range?grant=opaque',
      mimeType: category === 'video' ? 'video/mp4' : 'image/png',
      expiresAt: '2026-08-01T12:05:00.000Z'
    });
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={item(category)}
        client={previewClient}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Preparing the file preview…')).toBeTruthy();
    await waitFor(() => expect(document.body.querySelector(tag)).not.toBeNull());
    const media = document.body.querySelector(tag);
    expect(media?.getAttribute('src')).toContain('grant=opaque');
    expect(media?.getAttribute('referrerpolicy')).toBe('no-referrer');
    if (category === 'video') fireEvent.loadedData(media!);
    else fireEvent.load(media!);
    await waitFor(() => expect(screen.queryByText('Preparing the file preview…')).toBeNull());
    expect(previewClient.requestPreview).toHaveBeenCalledWith(
      TEAM_ID,
      `material-${category}`,
      'media'
    );
  });

  it('renders transcript text as text, marks truncation, and gates download/edit actions', async () => {
    const previewClient = client({
      kind: 'transcript',
      text: '<script>window.stolen = true</script>\nReadable cue',
      ingestState: 'truncated',
      truncated: true,
      indexedBytes: 1_048_576,
      sourceVersion: '17',
      allowedActions: ['download']
    });
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={item('transcript')}
        client={previewClient}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText(/Readable cue/u)).toBeTruthy();
    expect(document.body.querySelector('script')).toBeNull();
    expect(screen.getByText(/first 1 MiB/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download full file' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit text' })).toBeNull();
  });

  it('renders archive manifests and closes temporary agent sessions', async () => {
    const previewClient = client({
      kind: 'agent',
      operationId: 'archive-operation',
      previewKind: 'archive',
      transferGrant: {
        ticket: 'opaque-ticket',
        purpose: 'preview_range',
        expiresAt: '2026-08-01T12:05:00.000Z',
        maxRangeBytes: 33_554_432,
        maxUses: 512
      }
    });
    vi.mocked(previewClient.openAgentArchive).mockResolvedValue({
      kind: 'archive',
      operationId: 'archive-operation',
      entries: [
        { path: 'index.html', directory: false, sizeBytes: 128 },
        { path: 'assets/', directory: true, sizeBytes: 0 }
      ],
      truncated: false
    });
    const onClose = vi.fn();
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={item('archive')}
        client={previewClient}
        onClose={onClose}
      />
    );
    expect(await screen.findByText('index.html')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await waitFor(() =>
      expect(previewClient.closeAgentPreview).toHaveBeenCalledWith('archive-operation')
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('embeds landing content with scripts-only sandbox and offers screenshot fallback', async () => {
    const previewClient = client({
      kind: 'agent',
      operationId: 'landing-operation',
      previewKind: 'landing',
      transferGrant: {
        ticket: 'opaque-ticket',
        purpose: 'preview_range',
        expiresAt: '2026-08-01T12:05:00.000Z',
        maxRangeBytes: 33_554_432,
        maxUses: 512
      }
    });
    vi.mocked(previewClient.openAgentLanding).mockResolvedValue({
      kind: 'landing',
      operationId: 'landing-operation',
      url: 'http://127.0.0.1:54321/secret-capability/',
      sandbox: 'allow-scripts',
      warning: 'external_navigation_blocked',
      screenshotUrl: 'http://127.0.0.1:43120/api/team/preview/landing-operation/screenshot'
    });
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={item('landing')}
        client={previewClient}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => expect(document.body.querySelector('iframe')).not.toBeNull());
    const frame = document.body.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('src')).toContain('127.0.0.1:54321');
    expect(screen.getByText(/External navigation is blocked/u)).toBeTruthy();
    fireEvent.error(frame!);
    expect(await screen.findByRole('img', { name: 'Safe landing screenshot' })).toBeTruthy();
  });

  it.each([
    ['unsupported', 'This file type cannot be previewed.'],
    ['corrupt', 'This file is damaged or unreadable.'],
    ['protected', 'Password-protected files cannot be previewed.'],
    ['too_large', 'This file exceeds the safe preview limit.'],
    ['agent_required', 'Open or update the Soty app to preview this file.']
  ] as const)('shows the %s fallback without a false-ready surface', async (reason, copy) => {
    const previewClient = client({ kind: 'unavailable', reason, allowedActions: ['download'] });
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={item('other')}
        client={previewClient}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download file' })).toBeTruthy();
    expect(document.body.querySelector('video,img,iframe')).toBeNull();
  });

  it('turns permission loss into an explicit error and closes without retaining content', async () => {
    const previewClient = client({
      kind: 'unavailable',
      reason: 'unsupported',
      allowedActions: []
    });
    vi.mocked(previewClient.requestPreview).mockRejectedValue(new Error('PERMISSION_DENIED'));
    render(
      <MaterialPreview
        teamId={TEAM_ID}
        material={item('video')}
        client={previewClient}
        onClose={vi.fn()}
      />
    );
    expect(
      await screen.findByText('You no longer have permission to preview this file.')
    ).toBeTruthy();
    expect(screen.queryByText('Preparing the file preview…')).toBeNull();
  });
});
