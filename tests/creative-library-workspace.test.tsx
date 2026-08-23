// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render as renderRaw, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type LibraryAssetSummary } from '@video-compressor/shared';
import { MaterialBrowser } from '../apps/web/src/team/catalog/MaterialBrowser';
import { CreativeLibrary } from '../apps/web/src/team/library/CreativeLibrary';
import { LibraryAssetCard } from '../apps/web/src/team/library/LibraryAssetCard';
import { isCreativeLibraryAssetVisible } from '../apps/web/src/team/library/useCreativeLibrary';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { teamApi } from '../apps/web/src/api/team';
import { TaskDateFilterControl } from '../apps/web/src/team/tasks/TaskDateFilter';
import { localDateValue } from '../apps/web/src/team/tasks/useTasks';
import { ToastProvider } from '../apps/web/src/components/toast';

/**
 * Every surface in this file reports its outcomes through the shared toast
 * channel, so the provider is part of what they need to work rather than
 * scaffolding each test has to remember.
 */
const render = (ui: React.ReactElement) => renderRaw(<ToastProvider>{ui}</ToastProvider>);

const asset: LibraryAssetSummary = {
  id: '46000000-0000-4000-8000-000000000001',
  teamId: '46000000-0000-4000-8000-000000000002',
  name: 'launch.mp4',
  category: 'video',
  mimeType: 'video/mp4',
  fileExtension: 'mp4',
  sizeBytes: 1_024,
  lifecycle: 'active',
  sourceVersion: 'v1',
  stage: 'library',
  offer: 'Summer',
  language: 'uk',
  type: 'Video',
  placementState: 'ready',
  languageDecisionSource: 'manual',
  thumbnailState: 'ready',
  thumbnailTimeMs: 1_000,
  createdAt: '2026-08-14T10:00:00.000Z'
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Creative Library workspace controls', () => {
  it('keeps secondary card actions collapsed instead of turning every card into a button stack', () => {
    const styles = readFileSync(resolve(process.cwd(), 'apps/web/src/styles.css'), 'utf8');

    expect(styles).toContain('.creative-library-card .creative-library-card-more-actions,');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(styles).toContain('.creative-library-card .creative-library-card-more-actions .button,');
    expect(styles).toContain('box-sizing: border-box;');
    expect(styles).toContain('white-space: normal;');
    expect(styles).toContain('overflow-wrap: anywhere;');
  });

  it('uses a real preview request rather than telling the user to wait for an absent thumbnail job', () => {
    render(<LibraryAssetCard asset={{ ...asset, thumbnailState: 'pending' }} />);

    expect(screen.getByText('Loading preview…')).toBeTruthy();
    expect(screen.queryByText('Preview not created yet')).toBeNull();
    expect(screen.queryByText('Preparing the file preview…')).toBeNull();
  });

  it('loads a safe video URL only for the visible card and seeks a real frame at one second', async () => {
    const previewMaterial = vi.fn().mockResolvedValue({
      kind: 'media',
      rangeUrl: 'https://preview.example/launch.mp4',
      mimeType: 'video/mp4',
      expiresAt: '2026-08-15T12:00:00.000Z'
    });
    render(
      <LibraryAssetCard asset={asset} onPreview={vi.fn()} previewClient={{ previewMaterial }} />
    );

    const video = await waitFor(() => {
      const element = document.querySelector('video');
      expect(element).toBeTruthy();
      return element as HTMLVideoElement;
    });
    const setCurrentTime = vi.fn();
    Object.defineProperty(video, 'duration', { configurable: true, value: 15 });
    Object.defineProperty(video, 'currentTime', { configurable: true, set: setCurrentTime });
    fireEvent.loadedMetadata(video);
    fireEvent.seeked(video);

    expect(previewMaterial).toHaveBeenCalledWith(asset.teamId, asset.id, 'media');
    expect(video.getAttribute('src')).toBe('https://preview.example/launch.mp4');
    expect(setCurrentTime).toHaveBeenCalledWith(1);
    expect(
      video.closest('.creative-library-card-preview')?.getAttribute('data-preview-state')
    ).toBe('ready');
  });

  it('uses the short-lived thumbnail relay before downloading a video range for a card', async () => {
    const previewMaterial = vi.fn().mockResolvedValue({
      kind: 'media',
      rangeUrl: 'https://preview.example/drive-transfer/range?grant=opaque-ticket',
      mimeType: 'video/mp4',
      expiresAt: '2026-08-15T12:00:00.000Z'
    });
    render(
      <LibraryAssetCard asset={asset} onPreview={vi.fn()} previewClient={{ previewMaterial }} />
    );

    const thumbnail = await waitFor(() => {
      const element = document.querySelector('img.creative-library-card-preview-media');
      expect(element).toBeTruthy();
      return element as HTMLImageElement;
    });
    expect(thumbnail.getAttribute('src')).toBe(
      'https://preview.example/drive-transfer/thumbnail?grant=opaque-ticket'
    );
    fireEvent.load(thumbnail);

    expect(
      thumbnail.closest('.creative-library-card-preview')?.getAttribute('data-preview-state')
    ).toBe('ready');
    expect(document.querySelector('.creative-library-card-preview video')).toBeNull();
  });

  it('offers selection, task creation, placement correction and a one-second video preview', async () => {
    const onSelect = vi.fn();
    const onPreview = vi.fn();
    const onCreateTask = vi.fn();
    const onEditPlacement = vi.fn();
    const onTranscribe = vi.fn();
    vi.spyOn(teamApi, 'listVideoTextVariants').mockResolvedValue({
      sourceVersion: 'v1',
      canProcess: true,
      variants: []
    });
    render(
      <LibraryAssetCard
        asset={asset}
        selectable
        onSelect={onSelect}
        onPreview={onPreview}
        onCreateTask={onCreateTask}
        onEditPlacement={onEditPlacement}
        onTranscribe={onTranscribe}
      />
    );
    expect(screen.getByText('Loading preview…')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select launch.mp4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview launch.mp4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Drive placement' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe' }));
    expect(onSelect).toHaveBeenCalledWith(true);
    expect(onPreview).toHaveBeenCalledWith(asset);
    expect(onCreateTask).toHaveBeenCalledWith(asset);
    expect(onEditPlacement).toHaveBeenCalledWith(asset);
    expect(onTranscribe).toHaveBeenCalledWith(asset);
  });

  it('hides operating-system and organizer artefacts without hiding normal creative files', () => {
    expect(isCreativeLibraryAssetVisible({ ...asset, name: '.DS_Store' })).toBe(false);
    expect(isCreativeLibraryAssetVisible({ ...asset, name: '._launch.mp4' })).toBe(false);
    expect(isCreativeLibraryAssetVisible({ ...asset, name: '_organize_log.json' })).toBe(false);
    expect(isCreativeLibraryAssetVisible({ ...asset, name: 'landing-config.json' })).toBe(true);
  });

  it('uses a compact calendar for single dates or ranges and keeps status filters explicit', () => {
    const onChange = vi.fn();
    const onStatusChange = vi.fn();
    const first = new Date();
    const second = new Date(first);
    second.setDate(second.getDate() + 1);
    const firstDate = localDateValue(first);
    const secondDate = localDateValue(second);
    render(
      <TaskDateFilterControl
        value={{ kind: 'all' }}
        onChange={onChange}
        status="all"
        onStatusChange={onStatusChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open calendar' }));
    fireEvent.click(screen.getByRole('button', { name: firstDate }));
    fireEvent.click(screen.getByRole('button', { name: secondDate }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'range', from: firstDate, to: secondDate });

    fireEvent.click(screen.getByRole('button', { name: 'Open calendar' }));
    fireEvent.doubleClick(screen.getByRole('button', { name: firstDate }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'range', from: firstDate, to: firstDate });

    fireEvent.click(screen.getByRole('button', { name: 'To do' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onStatusChange.mock.calls.map(([value]) => value)).toEqual(['todo', 'done']);
  });

  it('creates a task directly from a file in the default media tree', async () => {
    const onCreateTask = vi.fn();
    const onPreview = vi.fn();
    render(
      <MaterialBrowser
        teamId={asset.teamId}
        client={{
          listMaterials: vi.fn().mockResolvedValue([
            {
              id: asset.id,
              teamId: asset.teamId,
              name: asset.name,
              kind: 'file',
              category: 'video'
            }
          ])
        }}
        onCreateTask={onCreateTask}
        onPreview={onPreview}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Preview launch.mp4' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }));
    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({ id: asset.id, name: asset.name, kind: 'file' })
    );
    expect(onCreateTask).toHaveBeenCalledWith({ id: asset.id, name: asset.name });
  });

  it('keeps a partially moved selection visible for safe retry', async () => {
    localStorage.setItem('wishly.active-team.v1', asset.teamId);
    const find = {
      ...asset,
      name: 'find.png',
      category: 'image' as const,
      mimeType: 'image/png',
      fileExtension: 'png',
      stage: 'finds' as const
    };
    const moveLibraryMaterials = vi.fn().mockResolvedValue({
      targetStage: 'library',
      succeeded: [],
      failed: [{ materialId: find.id, errorCode: 'GROUP_RECONCILING', retryable: true }]
    });
    render(
      <TeamProvider
        initialTeams={[
          {
            id: asset.teamId,
            name: 'Creative team',
            role: 'editor',
            permissions: DEFAULT_ROLE_PERMISSIONS.editor,
            connectionState: 'connected'
          }
        ]}
        realtime={false}
      >
        <CreativeLibrary
          teamId={asset.teamId}
          initialStage="finds"
          client={
            {
              listLibraryMaterials: vi.fn().mockResolvedValue([find]),
              moveLibraryMaterials
            } as never
          }
        />
      </TeamProvider>
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select find.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Library' }));
    expect(
      await screen.findByText(
        'Some files could not be moved. The unresolved group stays marked for a safe retry.'
      )
    ).toBeTruthy();
    expect(moveLibraryMaterials).toHaveBeenCalledWith(
      expect.objectContaining({ materialIds: [find.id], targetStage: 'library' })
    );
    expect(
      (screen.getByRole('checkbox', { name: 'Select find.png' }) as HTMLInputElement).checked
    ).toBe(true);
  });

  it('opens the safe media viewer from a Creative Library card', async () => {
    localStorage.setItem('wishly.active-team.v1', asset.teamId);
    const previewMaterial = vi.spyOn(teamApi, 'previewMaterial').mockResolvedValue({
      kind: 'media',
      rangeUrl: 'https://preview.example/launch.mp4',
      mimeType: 'video/mp4',
      expiresAt: '2026-08-15T12:00:00.000Z'
    });
    render(
      <TeamProvider
        initialTeams={[
          {
            id: asset.teamId,
            name: 'Creative team',
            role: 'editor',
            permissions: DEFAULT_ROLE_PERMISSIONS.editor,
            connectionState: 'connected'
          }
        ]}
        realtime={false}
      >
        <CreativeLibrary
          teamId={asset.teamId}
          client={
            {
              listLibraryMaterials: vi.fn().mockResolvedValue([asset]),
              moveLibraryMaterials: vi.fn()
            } as never
          }
        />
      </TeamProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Preview launch.mp4' }));
    expect(await screen.findByRole('dialog', { name: 'launch.mp4' })).toBeTruthy();
    await waitFor(() =>
      expect(previewMaterial).toHaveBeenCalledWith(asset.teamId, asset.id, 'media')
    );
    expect(document.querySelector('video')?.getAttribute('src')).toBe(
      'https://preview.example/launch.mp4'
    );
  });

  it('sends manual Offer/Language/Type correction as one structural group move', async () => {
    localStorage.setItem('wishly.active-team.v1', asset.teamId);
    const image = {
      ...asset,
      name: 'creative.png',
      category: 'image' as const,
      mimeType: 'image/png',
      fileExtension: 'png'
    };
    const moveLibraryMaterials = vi.fn().mockResolvedValue({
      targetStage: 'library',
      succeeded: [{ materialId: image.id, reused: false }],
      failed: []
    });
    render(
      <TeamProvider
        initialTeams={[
          {
            id: asset.teamId,
            name: 'Creative team',
            role: 'editor',
            permissions: DEFAULT_ROLE_PERMISSIONS.editor,
            connectionState: 'connected'
          }
        ]}
        realtime={false}
      >
        <CreativeLibrary
          teamId={asset.teamId}
          client={
            {
              listLibraryMaterials: vi.fn().mockResolvedValue([image]),
              moveLibraryMaterials
            } as never
          }
        />
      </TeamProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Drive placement' }));
    fireEvent.change(screen.getByLabelText('File language'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(moveLibraryMaterials).toHaveBeenCalledTimes(1));
    expect(moveLibraryMaterials).toHaveBeenCalledWith(
      expect.objectContaining({
        materialIds: [image.id],
        placement: { stage: 'library', offer: 'Summer', language: 'en', type: 'Video' }
      })
    );
  });
});
