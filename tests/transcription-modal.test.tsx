import { analytics } from '../apps/web/src/analytics/service';
// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  translationFingerprint,
  type TranscriptionDocument,
  type TranscriptionJob,
  type TranscriptTranslation,
  type TranslationStreamEvent
} from '@video-compressor/shared';
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

// 063: the viewer's translations come from one client the test controls.
const translations = vi.hoisted(() => ({
  start: vi.fn(),
  watch: vi.fn(),
  listForVideo: vi.fn(),
  listPersonal: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  allowance: vi.fn()
}));
vi.mock('../apps/web/src/translation/api.js', () => ({ translationClient: translations }));
vi.mock('../apps/web/src/api/assistant', () => ({
  creditsApi: {
    status: vi.fn(async () => ({
      grant: 100,
      available: 87,
      day: '2026-11-21',
      resetsAt: '2026-11-21T22:00:00Z',
      paidOpen: true,
      recent: []
    }))
  },
  assistantApi: {}
}));

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
  transcriptionTranslationRetry: 'Retry',
  transcriptionExport: 'Export',
  transcriptionExportOptions: 'Export options',
  transcriptionExportTxt: 'TXT',
  transcriptionExportSrt: 'SRT',
  transcriptionExportVtt: 'VTT',
  textTranslationCopied: 'Copied: {variant}',
  textTranslationDeleted: 'Deleted: {language}'
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
    translations.listPersonal.mockReset().mockResolvedValue([]);
    translations.watch.mockReset().mockResolvedValue(undefined);
    translations.start.mockReset();
    translations.get.mockReset();
    translations.remove.mockReset().mockResolvedValue(undefined);
    translations.allowance.mockReset().mockResolvedValue({
      feature: 'transcript_translation',
      limitUnits: 9000,
      usedUnits: 0,
      day: '2026-11-21',
      resetsAt: '2026-11-21T22:00:00Z'
    });

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
  describe('translations of the transcript (063)', () => {
    const twoSentences: TranscriptionDocument = {
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
    };

    async function ukrainian(
      overrides: Partial<TranscriptTranslation> = {}
    ): Promise<TranscriptTranslation> {
      return {
        id: '06300000-0000-4000-8000-000000000101',
        scope: 'personal',
        targetLanguage: 'uk',
        sourceLanguage: 'en',
        sourceFingerprint: await translationFingerprint(['Hello world.', 'Again.']),
        status: 'completed',
        failureCode: null,
        segments: ['Привіт, світе.', 'Знову.'],
        totalSegments: 2,
        completedSegments: 2,
        units: 18,
        model: 'claude-haiku-5-5',
        createdAt: '2026-11-21T10:00:00Z',
        completedAt: '2026-11-21T10:00:20Z',
        ...overrides
      };
    }

    const sourceColumn = () =>
      screen.getByRole('dialog').querySelector<HTMLElement>('[data-side="source"]')!;

    beforeEach(() => {
      api.transcriptionDocument.mockResolvedValue(twoSentences);
    });

    it('reads, copies, exports and deletes a translation in place of the original', async () => {
      const blobs: Blob[] = [];
      const names: string[] = [];
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: vi.fn((blob: Blob) => {
          blobs.push(blob);
          return 'blob:export';
        })
      });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement
      ) {
        names.push(this.download);
      });
      translations.listPersonal.mockResolvedValue([await ukrainian()]);
      const onExport = vi.fn();
      const onToast = vi.fn();
      const view = render(
        <TranscriptTextModal
          job={{ ...job, quality: 'accurate' }}
          language="en"
          returnFocus={null}
          onExport={onExport}
          onToast={onToast}
          onClose={vi.fn()}
          t={t}
        />
      );
      try {
        expect(await screen.findByText('transcriptionQualityAccurate')).toBeTruthy();
        // Filed under this job and the text itself, so another computer finds it too.
        await waitFor(() =>
          expect(translations.listPersonal).toHaveBeenCalledWith(job.id, expect.any(String))
        );
        fireEvent.click(await screen.findByRole('tab', { name: 'Ukrainian' }));
        await waitFor(() =>
          expect(sourceColumn().querySelector('.transcript-column-title')?.textContent).toBe(
            'Ukrainian'
          )
        );
        const paragraphs = sourceColumn().querySelectorAll('.text-variant-reader p');
        expect([...paragraphs].map(item => item.textContent)).toEqual(['Привіт, світе.', 'Знову.']);

        fireEvent.click(within(sourceColumn()).getByRole('button', { name: 'Copy all' }));
        await waitFor(() =>
          expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Привіт, світе.\nЗнову.')
        );
        expect(onToast).toHaveBeenCalledWith('Copied: Ukrainian', 'success');
        expect(
          within(sourceColumn()).getByRole('button', { name: 'Copied all text' })
        ).toBeTruthy();

        // Exported while open: the translation, named for its language, not the original.
        fireEvent.click(screen.getByRole('button', { name: 'Export' }));
        expect(onExport).not.toHaveBeenCalled();
        expect(names).toEqual(['private-video.uk.txt']);
        expect(await blobs[0]!.text()).toBe('Привіт, світе.\nЗнову.');
        // Subtitles carry the original's timings, one cue per sentence.
        fireEvent.click(screen.getByRole('button', { name: 'Export options' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: 'SRT' }));
        expect(names.at(-1)).toBe('private-video.uk.srt');
        const srt = await blobs.at(-1)!.text();
        expect(srt).toContain('00:00:00,000 --> 00:00:01,200\nПривіт, світе.');
        expect(srt).toContain('Знову.');

        fireEvent.click(screen.getByRole('button', { name: 'Delete translation' }));
        const confirm = await screen.findByRole('dialog', {
          name: /Delete the Ukrainian translation/u
        });
        fireEvent.click(within(confirm).getByRole('button', { name: 'Delete translation' }));
        await waitFor(() =>
          expect(translations.remove).toHaveBeenCalledWith('06300000-0000-4000-8000-000000000101')
        );
        await waitFor(() => expect(onToast).toHaveBeenCalledWith('Deleted: Ukrainian', 'success'));
        // Back on the original, which exports through the page again.
        await waitFor(() => expect(sourceColumn().textContent).toContain('Hello world.'));
        expect(screen.queryByRole('tab', { name: 'Ukrainian' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Export' }));
        expect(onExport).toHaveBeenCalledWith('txt', 'transcript');
      } finally {
        view.unmount();
        click.mockRestore();
      }
    });

    it('says when copying a translation failed', async () => {
      translations.listPersonal.mockResolvedValue([await ukrainian()]);
      vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'));
      const onToast = vi.fn();
      const view = render(
        <TranscriptTextModal
          job={job}
          language="en"
          returnFocus={null}
          onToast={onToast}
          onClose={vi.fn()}
          t={t}
        />
      );
      try {
        fireEvent.click(await screen.findByRole('tab', { name: 'Ukrainian' }));
        await waitFor(() => expect(sourceColumn().textContent).toContain('Знову.'));
        fireEvent.click(within(sourceColumn()).getByRole('button', { name: 'Copy all' }));
        await waitFor(() =>
          expect(onToast).toHaveBeenCalledWith('transcriptionFailedTitle', 'error')
        );
        // The original's copy says the same when the clipboard refuses.
        fireEvent.click(screen.getByRole('tab', { name: /Original/u }));
        await waitFor(() => expect(sourceColumn().textContent).toContain('Hello world.'));
        onToast.mockClear();
        fireEvent.click(within(sourceColumn()).getByRole('button', { name: 'Copy all' }));
        await waitFor(() =>
          expect(onToast).toHaveBeenCalledWith('transcriptionFailedTitle', 'error')
        );
      } finally {
        view.unmount();
      }
    });

    it('follows the player sentence by sentence and seeks from a sentence or a word', async () => {
      translations.listPersonal.mockResolvedValue([await ukrainian()]);
      let now = 0;
      const seeks: number[] = [];
      const originalTime = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'currentTime'
      );
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        configurable: true,
        get: () => now,
        set: (value: number) => {
          seeks.push(value);
        }
      });
      const view = render(
        <TranscriptTextModal job={job} language="en" returnFocus={null} onClose={vi.fn()} t={t} />
      );
      try {
        fireEvent.click(await screen.findByRole('tab', { name: 'Ukrainian' }));
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
        const dialog = screen.getByRole('dialog');
        const video = await waitFor(() => {
          const element = dialog.querySelector('video');
          if (!element) throw new Error('no player yet');
          return element;
        });
        now = 1.6;
        fireEvent(video, new Event('timeupdate'));
        await waitFor(() =>
          expect(
            sourceColumn().querySelector('.text-variant-reader p.is-active')?.textContent
          ).toBe('Знову.')
        );
        // Between sentences nothing is marked.
        now = 1.3;
        fireEvent(video, new Event('timeupdate'));
        await waitFor(() =>
          expect(sourceColumn().querySelector('.text-variant-reader p.is-active')).toBeNull()
        );
        fireEvent.click(sourceColumn().querySelectorAll('.text-variant-reader p')[1]!);
        expect(seeks).toContain(1.5);

        // On the original a word seeks to its own start.
        fireEvent.click(screen.getByRole('tab', { name: /Original/u }));
        const word = await waitFor(() => {
          const element = dialog.querySelector<HTMLElement>('[data-word-id="word-2"]');
          if (!element) throw new Error('no words yet');
          return element;
        });
        fireEvent.click(word);
        expect(seeks).toContain(0.5);
      } finally {
        view.unmount();
        if (originalTime)
          Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', originalTime);
        else delete (HTMLMediaElement.prototype as { currentTime?: number }).currentTime;
      }
    });

    it('shows a running translation, then its failure with a retry that starts it again', async () => {
      let emit: ((event: TranslationStreamEvent) => void) | null = null;
      translations.listPersonal.mockResolvedValue([
        await ukrainian({
          status: 'processing',
          segments: null,
          completedSegments: 1,
          model: null,
          completedAt: null
        })
      ]);
      translations.watch.mockImplementation(
        (_id: string, onEvent: (event: TranslationStreamEvent) => void) =>
          new Promise<void>(() => {
            emit = onEvent;
          })
      );
      translations.start.mockResolvedValue({
        translationId: '06300000-0000-4000-8000-000000000102',
        status: 'processing',
        reused: false,
        units: 18,
        allowance: null
      });
      const view = render(
        <TranscriptTextModal
          job={job}
          language="en"
          returnFocus={null}
          onExport={vi.fn()}
          onClose={vi.fn()}
          t={t}
        />
      );
      try {
        fireEvent.click(await screen.findByRole('tab', { name: /Ukrainian/u }));
        await waitFor(() => expect(sourceColumn().textContent).toMatch(/Translating: Ukrainian/u));
        // Nothing to copy, export or delete until it is there.
        expect(
          within(sourceColumn()).getByRole('button', { name: 'Copy all' }).hasAttribute('disabled')
        ).toBe(true);
        expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(true);
        expect(screen.queryByRole('button', { name: 'Delete translation' })).toBeNull();

        await waitFor(() => expect(emit).not.toBeNull());
        act(() => emit!({ type: 'failed', code: 'TRANSLATION_FAILED' }));
        expect(
          await within(sourceColumn()).findByText(/Could not translate\. Minutes returned\./u)
        ).toBeTruthy();
        fireEvent.click(within(sourceColumn()).getByRole('button', { name: 'Try again' }));
        await waitFor(() =>
          expect(translations.start).toHaveBeenCalledWith(
            'uk',
            {
              scope: 'personal',
              documentKey: job.id,
              sourceLanguage: 'en',
              segments: ['Hello world.', 'Again.']
            },
            expect.any(Number)
          )
        );
      } finally {
        view.unmount();
      }
    });

    it('marks a translation made from an earlier text', async () => {
      translations.listPersonal.mockResolvedValue([
        await ukrainian({ sourceFingerprint: `v1:${'0'.repeat(64)}` })
      ]);
      const view = render(
        <TranscriptTextModal job={job} language="en" returnFocus={null} onClose={vi.fn()} t={t} />
      );
      try {
        fireEvent.click(await screen.findByRole('tab', { name: /Ukrainian/u }));
        expect(await within(sourceColumn()).findByText('textTranslationStale')).toBeTruthy();
        // Still readable while outdated.
        expect(sourceColumn().textContent).toContain('Привіт, світе.');
      } finally {
        view.unmount();
      }
    });
  });

  it('says a transcript failed to load and loads it again on request', async () => {
    api.transcriptionDocument
      .mockRejectedValueOnce(new Error('agent restarting'))
      .mockResolvedValueOnce(documentFixture);
    forgetTranscriptDocuments();
    const view = render(
      <TranscriptTextModal job={job} language="uk" returnFocus={null} onClose={vi.fn()} t={t} />
    );
    try {
      expect(await screen.findByText('transcriptionModalLoadFailed')).toBeTruthy();
      // Never the "no speech" sentence over a transcript that exists.
      expect(screen.queryByText('transcriptionModalEmpty')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'tryAgain' }));
      await waitFor(() =>
        expect(
          screen.getByRole('dialog').querySelector('[data-side="source"]')?.textContent
        ).toContain('Hello world.')
      );
    } finally {
      view.unmount();
    }
  });

  it('says a file had no speech, and names the fast quality', async () => {
    api.transcriptionDocument.mockResolvedValue({ ...documentFixture, segments: [] });
    const view = render(
      <TranscriptTextModal
        job={{ ...job, quality: 'fast' }}
        language="uk"
        returnFocus={null}
        onClose={vi.fn()}
        t={t}
      />
    );
    try {
      expect(await screen.findByText('transcriptionModalEmpty')).toBeTruthy();
      expect(screen.getByText('transcriptionQualityFast')).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it('says a preview could not be prepared and retries it; a preparing one can be cancelled', async () => {
    api.transcriptionMediaPrepare
      .mockReset()
      .mockResolvedValueOnce({
        state: 'failed',
        variant: 'original',
        progress: null,
        hasVideo: true,
        mimeType: null,
        error: 'decode'
      })
      .mockResolvedValueOnce({
        state: 'preparing',
        variant: 'proxy',
        progress: 40,
        hasVideo: true,
        mimeType: null,
        error: null
      });
    api.transcriptionMediaStatus.mockReturnValue(new Promise(() => {}));
    const view = render(
      <TranscriptTextModal job={job} language="uk" returnFocus={null} onClose={vi.fn()} t={t} />
    );
    try {
      await waitFor(() =>
        expect(screen.getByRole('dialog').querySelector('[data-word-id="word-1"]')).not.toBeNull()
      );
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      expect(await screen.findByText('Preview unavailable')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'transcriptionRetry' }));
      expect(await screen.findByText('Preparing preview… 40%')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(api.transcriptionMediaCancel).toHaveBeenCalledWith(job.id));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Preview' }).getAttribute('aria-expanded')).toBe(
          'false'
        )
      );
    } finally {
      view.unmount();
    }
  });

  it('offers sound alone where the window is too short for a picture', async () => {
    reduced = true;
    const view = render(
      <TranscriptTextModal job={job} language="uk" returnFocus={null} onClose={vi.fn()} t={t} />
    );
    try {
      expect(await screen.findByRole('button', { name: 'Play sound' })).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it('clears a selection before Escape closes the viewer', async () => {
    const onClose = vi.fn();
    const view = render(
      <TranscriptTextModal job={job} language="uk" returnFocus={null} onClose={onClose} t={t} />
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
      await waitFor(() => expect(dialog.querySelector('.ts-selected')).not.toBeNull());
      fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
      await waitFor(() => expect(dialog.querySelector('.ts-selected')).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
      window.getSelection()!.removeAllRanges();
      fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    } finally {
      view.unmount();
      window.getSelection()?.removeAllRanges();
    }
  });
});
