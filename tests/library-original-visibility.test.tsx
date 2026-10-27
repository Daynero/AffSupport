// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  parseLibraryVideoTextVariants,
  type LibraryVideoTextVariants
} from '@video-compressor/shared';
import { VideoTextActions } from '../apps/web/src/team/library/VideoTextActions';
import { analytics } from '../apps/web/src/analytics/service';
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));
const attempt = '81000000-0000-4000-8000-000000000002';
const fixture = (attemptId: string | null = attempt): LibraryVideoTextVariants => ({
  sourceVersion: 'synthetic-source-version',
  canProcess: true,
  variants: [
    {
      materialId: '81000000-0000-4000-8000-000000000003',
      kind: 'original',
      language: 'uk',
      ingestState: 'full',
      truncated: false,
      text: 'Private synthetic words',
      updatedAt: '2026-10-27T00:00:00Z',
      attemptId
    }
  ]
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('preserves an opaque accepted attempt and refuses content-shaped identity', () => {
  expect(parseLibraryVideoTextVariants(fixture())?.variants[0]?.attemptId).toBe(attempt);
  const invalid = fixture();
  invalid.variants[0]!.attemptId = 'private-file.mp4';
  expect(parseLibraryVideoTextVariants(invalid)).toBeNull();
});
it('records visibility after the original is rendered, once per accepted result', async () => {
  const user = userEvent.setup();
  render(
    <VideoTextActions
      teamId="team"
      videoId="video"
      client={{ listVideoTextVariants: async () => fixture() }}
      onTranscribe={() => {}}
    />
  );
  const view = await screen.findByRole('button', { name: /view text|переглянути текст/iu });
  expect(analytics.track).not.toHaveBeenCalled();
  await user.click(view);
  expect(await screen.findByText('Private synthetic words')).toBeTruthy();
  await waitFor(() =>
    expect(analytics.track).toHaveBeenCalledWith(
      'result_opened',
      expect.objectContaining({
        attempt_id: attempt,
        flow_step: 'library_original_processing',
        action_identifier: 'visible'
      })
    )
  );
  expect(JSON.stringify(vi.mocked(analytics.track).mock.calls)).not.toMatch(
    /Private|synthetic-source-version|materialId|videoId/u
  );
  expect(vi.mocked(analytics.track).mock.calls).toHaveLength(1);
});
it('does not invent processing provenance for a legacy companion', async () => {
  const user = userEvent.setup();
  render(
    <VideoTextActions
      teamId="team"
      videoId="video"
      client={{ listVideoTextVariants: async () => fixture(null) }}
      onTranscribe={() => {}}
    />
  );
  await user.click(await screen.findByRole('button', { name: /view text|переглянути текст/iu }));
  expect(await screen.findByText('Private synthetic words')).toBeTruthy();
  expect(analytics.track).not.toHaveBeenCalled();
});
it('records copying only after the clipboard confirms success', async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, 'writeText')
    .mockRejectedValueOnce(new Error('denied'))
    .mockResolvedValueOnce();
  render(
    <VideoTextActions
      teamId="team"
      videoId="video"
      client={{ listVideoTextVariants: async () => fixture() }}
      onTranscribe={() => {}}
    />
  );
  const copy = await screen.findByRole('button', { name: /copy text|скопіювати текст/iu });
  await user.click(copy);
  expect(write).toHaveBeenCalledTimes(1);
  expect(analytics.track).not.toHaveBeenCalled();
  await user.click(copy);
  expect(analytics.track).toHaveBeenCalledWith(
    'operation_stage_completed',
    expect.objectContaining({ attempt_id: attempt, action_identifier: 'copied' })
  );
});
