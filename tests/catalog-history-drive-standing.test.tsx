// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogUpdateAttempt } from '@video-compressor/shared';
import { CatalogStatusDetails } from '../apps/web/src/team/catalog-updater/CatalogStatusDetails';
import { en } from '../apps/web/src/locales/en';

/**
 * 072 П5: «Поточна проблема: Підключення до Drive треба поновити…» on a catalog of a folder the
 * space no longer uses told the owner to do something that could not help. The history now says
 * what happened, whether it is serious and what to do, from where the catalog stands with Drive.
 */

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(cleanup);

const failed: CatalogUpdateAttempt = {
  attemptId: 'failed',
  catalogId: 'catalog',
  trigger: 'manual',
  startedAt: '2026-11-10T11:39:59Z',
  endedAt: '2026-11-11T10:25:01Z',
  stage: null,
  result: 'failed',
  failureCode: 'NEEDS_REAUTH',
  deliveryVerifiedAt: null,
  profileVersion: 1,
  profileSnapshot: null,
  actualChanges: null
} as CatalogUpdateAttempt;

const base = {
  teamId: 'team',
  catalogId: 'catalog',
  currentFailureCode: 'NEEDS_REAUTH',
  load: vi.fn(async () => [failed]),
  onClose: vi.fn(),
  onRetry: vi.fn(),
  sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit'
};

it('names a catalog of the previous folder as such, with no reconnect and no retry', async () => {
  render(
    <CatalogStatusDetails
      {...base}
      driveConnection={{ state: 'detached', folderName: 'Old', spaceFolderName: 'New' }}
    />
  );
  expect(await screen.findByText(en.catalogOtherFolderTitle)).toBeTruthy();
  expect(
    screen.getByText(/now works with the folder «New», and this sheet is in «Old»/)
  ).toBeTruthy();
  expect(screen.getByRole('link', { name: en.catalogIconsOpenSheet })).toBeTruthy();
  // The past failure is told as what it was, not «reconnect Drive».
  expect(await screen.findByText(en.catalogOtherFolderAttemptReason)).toBeTruthy();
  expect(screen.queryByRole('button', { name: en.catalogUpdaterRetryNow })).toBeNull();
  expect(screen.queryByText(en.catalogUpdaterCurrentProblem)).toBeNull();
});

it('a Drive failure whose Drive works again offers the retry, not a scary problem', async () => {
  render(<CatalogStatusDetails {...base} driveConnection={{ state: 'connected' }} />);
  expect(await screen.findByText(en.catalogDriveRestoredTitle)).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: en.catalogUpdaterRetryNow }));
  expect(base.onRetry).toHaveBeenCalledWith('failed');
  // One retry, in the alert: not a second one under the list.
  expect(screen.getAllByRole('button', { name: en.catalogUpdaterRetryNow })).toHaveLength(1);
});

it('a connection that needs signing in again says so in plain words', async () => {
  render(<CatalogStatusDetails {...base} driveConnection={{ state: 'needs_reauth' }} />);
  expect(await screen.findByText(en.catalogDriveReconnectTitle)).toBeTruthy();
  expect(screen.getByText(en.catalogDriveReconnectBody)).toBeTruthy();
});

it('keeps each try on one line with its details folded', async () => {
  render(<CatalogStatusDetails {...base} driveConnection={{ state: 'connected' }} />);
  const toggle = await screen.findByRole('button', { name: en.catalogUpdaterDetails });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText(en.catalogUpdaterResult_failed)).toBeTruthy();
});
