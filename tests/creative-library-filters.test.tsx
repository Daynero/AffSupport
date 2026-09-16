// @vitest-environment jsdom
import React from 'react';
import { cleanup, render as renderRaw, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAssetSummary } from '@video-compressor/shared';
import { isCreativeLibraryAssetVisible } from '../apps/web/src/team/library/useCreativeLibrary';
import { TaskDateFilterControl } from '../apps/web/src/team/tasks/TaskDateFilter';
import { localDateValue } from '../apps/web/src/team/tasks/useTasks';
import { ToastProvider } from '../apps/web/src/components/toast';

/**
 * What survives of the Creative Library workspace tests after 011 merged that
 * surface into the explorer: the visibility rule for organiser artefacts and
 * the task date filter. Cards, selection and placement now live in the
 * explorer's grid (tests/team-explorer-*.test.tsx); bulk upload, processing
 * and sharing keep their own suites.
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

describe('Creative Library rules that outlived the surface', () => {
  it('hides operating-system and organizer artefacts without hiding normal creative files', () => {
    expect(isCreativeLibraryAssetVisible({ ...asset, name: '.DS_Store' })).toBe(false);
    expect(isCreativeLibraryAssetVisible({ ...asset, name: '._launch.mp4' })).toBe(false);
    expect(isCreativeLibraryAssetVisible({ ...asset, name: '_organize_log.json' })).toBe(false);
    expect(isCreativeLibraryAssetVisible({ ...asset, name: 'landing-config.json' })).toBe(true);
  });

  /**
   * 024 put the inventory's calendar here, so a day is asked for by the name
   * the locale gives it rather than by `YYYY-MM-DD`, and the double-click that
   * used to mean "just this one day" is gone: clicking the same day twice is a
   * one-day range, which is the same outcome with one fewer thing to know.
   */
  it('takes a range from the calendar and keeps status filters explicit', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onStatusChange = vi.fn();
    const first = new Date();
    const second = new Date(first);
    second.setDate(second.getDate() + 1);
    const firstDate = localDateValue(first);
    const secondDate = localDateValue(second);
    const dayName = (date: Date) =>
      new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(date);
    render(
      <TaskDateFilterControl
        value={{ kind: 'all' }}
        onChange={onChange}
        status="all"
        onStatusChange={onStatusChange}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Open calendar' }));
    await user.click(screen.getByRole('button', { name: new RegExp(dayName(first)) }));
    // Half a range commits nothing; the day picked is not thrown away either.
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: new RegExp(dayName(second)) }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'range', from: firstDate, to: secondDate });

    await user.click(screen.getByRole('button', { name: 'To do' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onStatusChange.mock.calls.map(([value]) => value)).toEqual(['todo', 'done']);
  });
});
