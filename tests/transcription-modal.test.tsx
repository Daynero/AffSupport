import { analytics } from '../apps/web/src/analytics/service';
// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptionDocument, TranscriptionJob } from '@video-compressor/shared';
import type { Translate } from '../apps/web/src/components/ui.js';

const api = vi.hoisted(() => ({
  transcriptionDocument: vi.fn(),
  transcriptionTranslate: vi.fn(),
  transcriptionTranslation: vi.fn(),
  transcriptionMediaPrepare: vi.fn(),
  transcriptionMediaStatus: vi.fn(),
  transcriptionMediaCancel: vi.fn(),
  transcriptionMediaUrl: vi.fn(async () => 'http://127.0.0.1:43131/local-media'),
  // The path builder the ticketed hook uses; the URL itself is now resolved
  // asynchronously against a capability ticket.
  transcriptionMediaPath: vi.fn((id: string) => `/api/transcription/jobs/${id}/media`),
  // The hook reaches for the origin through this module when it builds the
  // ticketed URL; a mock without it produces `undefined/api/...`.
  agentUrl: 'http://127.0.0.1:43131'
}));

vi.mock('../apps/web/src/api/client.js', () => api);

import { TranscriptTextModal } from '../apps/web/src/transcription/TranscriptTextModal.js';
import { forgetTranscriptDocuments } from '../apps/web/src/transcription/document-cache.js';

const job: TranscriptionJob = {
  id: 'modal-job',
  inputPath: '',
  fileName: 'private-video.mp4',
  sourceKind: 'local',
  sourceKey: null,
  durationSeconds: 2,
  status: 'completed',
  progress: 100,
  requestedLanguage: 'en',
  detectedLanguage: 'en',
  text: null,
  characters: 12,
  error: null,
  errorDetails: null,
  batchId: 'batch',
  createdAt: 1,
  startedAt: 2,
  finishedAt: 3
};

const documentFixture: TranscriptionDocument = {
  jobId: job.id,
  sourceLanguage: 'en',
  modelVersion: 'large-v3',
  segments: [
    {
      id: 'segment-1',
      startMs: 0,
      endMs: 1_200,
      sourceText: 'Hello world.',
      words: [
        {
          id: 'word-1',
          text: 'Hello',
          startMs: 0,
          endMs: 500,
          confidence: 0.95,
          sourceStart: 0,
          sourceEnd: 5
        },
        {
          id: 'word-2',
          text: 'world.',
          startMs: 500,
          endMs: 1_200,
          confidence: 0.93,
          sourceStart: 6,
          sourceEnd: 12
        }
      ]
    }
  ]
};

const labels: Record<string, string> = {
  transcriptionDetected: 'Detected: {language}',
  transcriptionCharacters: '{count} characters',
  transcriptionMatchLabel: 'Selection match',
  transcriptionMatchHint: 'Correspondence estimate, not a translation guarantee.',
  transcriptionMatchEmpty: 'Select text',
  transcriptionMatchExact: 'Exact',
  transcriptionMatchHigh: 'High',
  transcriptionMatchApprox: 'Approximate',
  transcriptionModalClose: 'Close',
  transcriptionSourceColumn: 'Original',
  transcriptionTranslationColumn: 'Translation',
  transcriptionCopyAll: 'Copy all',
  transcriptionCopySelection: 'Copy selection',
  transcriptionCopiedAll: 'Copied all text',
  transcriptionCopiedSelection: 'Copied selection',
  transcriptionLanguageSearch: 'Search languages',
  transcriptionTranslating: 'Translating into {language}…',
  transcriptionTranslationEmpty: 'Translation is empty',
  transcriptionPreview: 'Preview',
  transcriptionPreviewSound: 'Play sound',
  transcriptionPreviewCollapse: 'Hide preview',
  transcriptionPreviewPreparing: 'Preparing preview…',
  transcriptionPreviewUnavailable: 'Preview unavailable',
  transcriptionPlayerPlay: 'Play',
  transcriptionPlayerPause: 'Pause',
  transcriptionPlayerSeek: 'Seek',
  transcriptionPlayerVolume: 'Volume',
  transcriptionPlayerSpeed: 'Playback speed',
  transcriptionPlayerFullscreen: 'Full screen',
  transcriptionKaraokeUnavailable: 'Karaoke unavailable',
  transcriptionCancel: 'Cancel',
  transcriptionTranslationRetry: 'Retry'
};

const t = ((key: string, values?: Record<string, unknown>) => {
  let value = labels[key] ?? key;
  for (const [name, replacement] of Object.entries(values ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}) as Translate;

/**
 * The player's source is resolved through a capability ticket, so the component
 * asks the local app for one before it has a URL. Without this stub the src is
 * empty and the failure reads as missing markup rather than a missing round
 * trip.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ticket: '9999999999.stub', expiresInMs: 300_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
  );
});

describe('original transcript modal integration', () => {
  let reduced = false;
  const motionListeners = new Set<() => void>();

  beforeEach(() => {
    reduced = false;
    motionListeners.clear();
    // The document cache is module-wide; one test's document must not be the next one's.
    forgetTranscriptDocuments();
    api.transcriptionDocument.mockReset().mockResolvedValue(documentFixture);
    api.transcriptionMediaPrepare.mockReset().mockResolvedValue({
      state: 'ready',
      variant: 'original',
      progress: 100,
      hasVideo: true,
      mimeType: 'video/mp4',
      error: null
    });
    api.transcriptionMediaStatus.mockReset();
    api.transcriptionMediaCancel.mockReset().mockResolvedValue({ ok: true });
    api.transcriptionMediaUrl.mockClear();

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        get matches() {
          return reduced;
        },
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => motionListeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) =>
          motionListeners.delete(listener),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true
      }))
    });
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value }
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined)
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: vi.fn()
    });
  });

  it('shows uncertainty and partial timing without hiding source text', async () => {
    api.transcriptionDocument.mockResolvedValue({
      ...documentFixture,
      reliability: {
        windows: 1,
        retries: 2,
        recoveredWindows: 0,
        timedWords: 1,
        totalWords: 5,
        warnings: [
          { code: 'SEAM_UNCERTAIN', startMs: 0, endMs: 2000 },
          { code: 'DECODE_UNCERTAIN', startMs: 0, endMs: 2000 }
        ]
      }
    });
    const view = render(
      <TranscriptTextModal job={job} language="uk" returnFocus={null} onClose={vi.fn()} t={t} />
    );
    expect(await screen.findByText('transcriptionReviewNeeded')).not.toBeNull();
    expect(screen.getByText('transcriptionTimingsPartial')).not.toBeNull();
    expect(screen.getByRole('dialog').querySelector('[data-side="source"]')?.textContent).toContain(
      'Hello world.'
    );
    view.unmount();
  });

  it('is read by keyboard before playback: one stop per column, arrows between segments, Enter opens the player there', async () => {
    // Two segments, so there is somewhere for the arrows to go.
    api.transcriptionDocument.mockResolvedValue({
      ...documentFixture,
      segments: [
        ...documentFixture.segments,
        {
          id: 'segment-2',
          startMs: 1_500,
          endMs: 2_400,
          sourceText: 'Again.',
          words: [
            {
              id: 'word-3',
              text: 'Again.',
              startMs: 1_500,
              endMs: 2_400,
              confidence: 0.9,
              sourceStart: 0,
              sourceEnd: 6
            }
          ]
        }
      ]
    });
    const seeks: number[] = [];
    const originalTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    const originalReady = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: (value: number) => {
        seeks.push(value);
      }
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get: () => 1
    });
    let view: ReturnType<typeof render> | null = null;
    try {
      view = render(
        <TranscriptTextModal
          job={job}
          language="uk"
          returnFocus={null}
          onToast={() => {}}
          onClose={() => {}}
          t={t}
        />
      );
      const dialog = await screen.findByRole('dialog');
      const source = await waitFor(() => {
        const column = dialog.querySelector<HTMLElement>(
          '[data-side="source"] .transcript-column-scroll'
        );
        if (!column || column.querySelectorAll('[data-segment-id]').length < 2) {
          throw new Error('no text');
        }
        return column;
      });
      const segments = Array.from(source.querySelectorAll<HTMLElement>('[data-segment-id]'));
      // The column is one Tab stop; nothing is gated on the player being open.
      expect(segments.map(segment => segment.tabIndex)).toEqual([
        0,
        ...segments.slice(1).map(() => -1)
      ]);
      segments[0].focus();
      // Dispatched on the segment: the scroller's handler reads the target it bubbled from.
      fireEvent.keyDown(segments[0], { key: 'ArrowDown' });
      expect(document.activeElement).toBe(segments[1]);
      fireEvent.keyDown(segments[1], { key: 'ArrowUp' });
      expect(document.activeElement).toBe(segments[0]);

      // Enter with no player open: the player opens and seeks to the segment's first word.
      fireEvent.keyDown(segments[1], { key: 'Enter' });
      await waitFor(() => expect(api.transcriptionMediaPrepare).toHaveBeenCalled());
      await waitFor(() => expect(dialog.querySelector('video')).not.toBeNull());
      const firstWord = segments[1].querySelector<HTMLElement>('[data-word-start-ms]');
      await waitFor(() => expect(seeks).toContain(Number(firstWord?.dataset.wordStartMs) / 1000));
    } finally {
      // The next test renders its own dialog; this one must not be there to be found first.
      view?.unmount();
      if (originalTime)
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', originalTime);
      else delete (HTMLMediaElement.prototype as { currentTime?: number }).currentTime;
      if (originalReady)
        Object.defineProperty(HTMLMediaElement.prototype, 'readyState', originalReady);
      else delete (HTMLMediaElement.prototype as { readyState?: number }).readyState;
    }
  });
  it('copies the original selection and retains it while opening media preview', async () => {
    const view = render(
      <TranscriptTextModal job={job} language="uk" returnFocus={null} onClose={vi.fn()} t={t} />
    );
    try {
      const dialog = screen.getByRole('dialog');
      await waitFor(() => expect(dialog.querySelector('[data-word-id="word-1"]')).not.toBeNull());
      const word = dialog.querySelector<HTMLElement>('[data-word-id="word-1"]')!;
      fireEvent.pointerDown(word);
      const range = document.createRange();
      range.selectNodeContents(word);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      fireEvent.pointerUp(word);
      await waitFor(() => expect(dialog.querySelector('.ts-selected')?.textContent).toBe('Hello'));
      fireEvent.click(screen.getByRole('button', { name: 'Copy selection' }));
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Hello'));
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      await waitFor(() => expect(api.transcriptionMediaPrepare).toHaveBeenCalled());
      expect(dialog.querySelector('.ts-selected')?.textContent).toBe('Hello');
      expect(dialog.querySelector('[data-side="target"]')).toBeNull();
    } finally {
      view.unmount();
      window.getSelection()?.removeAllRanges();
    }
  });
  it('reports visibility only after the completed attempt document commits, including equal finish times', async () => {
    const id = '81000000-0000-4000-8000-000000000001';
    const attempt = '81000000-0000-4000-8000-000000000002';
    let resolveFirst!: (doc: TranscriptionDocument) => void;
    api.transcriptionDocument.mockReturnValue(
      new Promise<TranscriptionDocument>(resolve => {
        resolveFirst = resolve;
      })
    );
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    const visible = () => track.mock.calls.filter(([name]) => name === 'result_opened');
    const current = {
      ...job,
      id,
      attemptId: attempt,
      status: 'processing' as const,
      finishedAt: null
    };
    const view = render(
      <TranscriptTextModal
        job={current}
        language="uk"
        returnFocus={null}
        onClose={() => {}}
        t={t}
      />
    );
    try {
      expect(api.transcriptionDocument).not.toHaveBeenCalled();
      view.rerender(
        <TranscriptTextModal
          job={{ ...current, status: 'completed', finishedAt: 10 }}
          language="uk"
          returnFocus={null}
          onClose={() => {}}
          t={t}
        />
      );
      expect(visible()).toHaveLength(0);
      await act(async () => {
        resolveFirst({ ...documentFixture, jobId: id });
      });
      await waitFor(() => expect(visible()).toHaveLength(1));
      expect(visible()[0][1]).toMatchObject({
        attempt_id: attempt,
        flow_step: 'transcription_result_visible'
      });
      const retry = '81000000-0000-4000-8000-000000000003';
      let resolveRetry!: (doc: TranscriptionDocument) => void;
      api.transcriptionDocument.mockReturnValue(
        new Promise<TranscriptionDocument>(resolve => {
          resolveRetry = resolve;
        })
      );
      view.rerender(
        <TranscriptTextModal
          job={{ ...current, attemptId: retry, status: 'completed', finishedAt: 10 }}
          language="uk"
          returnFocus={null}
          onClose={() => {}}
          t={t}
        />
      );
      expect(visible()).toHaveLength(1);
      await waitFor(() => expect(api.transcriptionDocument).toHaveBeenCalledTimes(2));
      await act(async () => {
        resolveRetry({ ...documentFixture, jobId: id });
      });
      await waitFor(() => expect(visible()).toHaveLength(2));
      expect(visible()[1][1]).toMatchObject({ attempt_id: retry });
    } finally {
      view.unmount();
      track.mockRestore();
    }
  });
});
