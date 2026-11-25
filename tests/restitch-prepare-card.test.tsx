// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestitchPreparationState } from '../apps/web/src/team/restitch/useRestitchPreparation';

/**
 * "Re-stitched videos in seconds" (071): the space's preparation as a card that says what it
 * gives, how much of the space is ready in every state, and — while it works — which video it is
 * on and roughly how long is left, so a long video reads as work and not as a hang.
 */

const { RestitchPrepareCard } =
  await import('../apps/web/src/team/workspace/restitch/RestitchPrepareCard');

const idle: RestitchPreparationState = {
  phase: 'idle',
  done: 0,
  total: 0,
  ready: 0,
  unsupported: 0,
  failed: 0,
  errorCode: null
};

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

function renderCard(props: Partial<Parameters<typeof RestitchPrepareCard>[0]> = {}): {
  onStart: ReturnType<typeof vi.fn>;
  onPause: ReturnType<typeof vi.fn>;
} {
  const onStart = vi.fn();
  const onPause = vi.fn();
  render(
    <RestitchPrepareCard
      state={idle}
      readiness={{ total: 256, ready: 0, lastPreparedAt: null }}
      connected
      driveConnected
      off={false}
      onStart={onStart}
      onPause={onPause}
      {...props}
    />
  );
  return { onStart, onPause };
}

describe('the preparation card', () => {
  it('leads with what it gives and offers to speed the space up', () => {
    const { onStart } = renderCard();
    expect(screen.getByRole('heading', { name: 'Re-stitched videos in seconds' })).toBeTruthy();
    expect(screen.getByText('0 of 256 videos ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Speed up the space' }));
    expect(onStart).toHaveBeenCalled();
  });

  it('offers only the rest once part of the space is ready', () => {
    renderCard({ readiness: { total: 256, ready: 3, lastPreparedAt: null } });
    expect(screen.getByText('3 of 256 videos ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prepare the rest: 253' })).toBeTruthy();
  });

  it('names the video in hand, the time on it and what is left, and pauses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    const now = Date.now();
    const { onPause } = renderCard({
      state: {
        ...idle,
        phase: 'running',
        done: 5,
        ready: 5,
        total: 256,
        already: 3,
        startedAt: now - 4 * 60_000,
        current: { name: 'BG 12.mp4', since: now - 2 * 60_000 }
      }
    });
    // Two videos in four minutes: 251 left at two minutes each.
    expect(screen.getByRole('status').textContent).toBe(
      'Reading “BG 12.mp4” · 2 min on this video · about 502 min left'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalled();
  });

  it('says a pause keeps what is done, and continues', () => {
    renderCard({
      state: { ...idle, phase: 'canceled', done: 5, ready: 5, total: 256, already: 3 }
    });
    expect(screen.getByText('5 of 256 videos ready')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Paused');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('settles quietly when every video is ready', () => {
    renderCard({
      readiness: { total: 12, ready: 12, lastPreparedAt: '2026-11-24T10:00:00.000Z' }
    });
    expect(screen.getByText(/All 12 videos ready/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says what stands in the way instead of offering a run that cannot start', () => {
    renderCard({ driveConnected: false });
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    renderCard({ connected: false });
    expect(
      screen.getByRole('button', { name: 'Speed up the space' }).hasAttribute('disabled')
    ).toBe(true);
    expect(screen.getByText('This needs the Soty app running on this computer.')).toBeTruthy();
  });

  it('shows the download of the video in hand by the byte (071)', () => {
    renderCard({
      state: {
        ...idle,
        phase: 'running',
        done: 1,
        ready: 1,
        total: 256,
        current: { name: 'BG 12.mp4', since: Date.now() },
        mediaPhase: 'downloading',
        mediaProgress: 0.2,
        mediaBytes: 400 * 1024 * 1024,
        mediaBytesTotal: 1024 * 1024 * 1024
      }
    });
    expect(screen.getByRole('status').textContent).toBe('Downloading “BG 12.mp4” · 400 MB of 1 GB');
  });

  it('shows the space preparing itself, and lets it be switched off (071)', () => {
    const onAutoChange = vi.fn();
    renderCard({
      readiness: { total: 256, ready: 10, lastPreparedAt: null },
      auto: true,
      onAutoChange,
      background: {
        teamId: 'team',
        status: 'running',
        current: { name: 'BG 13.mp4', since: Date.now() },
        phase: 'downloading',
        progress: 0.1,
        bytes: 0,
        bytesTotal: null,
        prepared: 0
      }
    });
    expect(screen.getByRole('status').textContent).toBe(
      'In the background · Downloading “BG 13.mp4”'
    );
    const toggle = screen.getByRole('switch', { name: 'Prepare automatically' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(onAutoChange).toHaveBeenCalledWith(false);
  });

  it('says the rest waits for a free Soty while background preparation is on (071)', () => {
    renderCard({
      readiness: { total: 256, ready: 10, lastPreparedAt: null },
      auto: true,
      onAutoChange: () => {},
      background: {
        teamId: 'team',
        status: 'waiting',
        current: null,
        phase: null,
        progress: 0,
        bytes: 0,
        bytesTotal: null,
        prepared: 0
      }
    });
    expect(screen.getByRole('status').textContent).toBe(
      'The rest will be prepared in the background as soon as Soty is free.'
    );
  });
});
