// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptionModelInfo,
  TranslationDocument
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

const installedModel: TranscriptionModelInfo = {
  present: true,
  downloading: false,
  progress: 100,
  sizeBytes: 0,
  downloadedBytes: 0,
  label: 'local translation',
  error: null
};

function translated(
  targetLanguage: string,
  translatedText: string,
  targetEnd = translatedText.length
): TranslationDocument {
  return {
    targetLanguage,
    modelVersion: 'fake-current',
    alignmentStatus: 'completed',
    status: 'completed',
    segments: [
      {
        sourceSegmentId: 'segment-1',
        translatedText,
        alignments: [
          {
            sourceStart: 0,
            sourceEnd: 5,
            targetStart: 0,
            targetEnd,
            confidence: 0.96
          }
        ]
      }
    ],
    error: null
  };
}

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
  ],
  // This deliberately stale sidecar value must be revalidated via POST.
  translations: { uk: translated('uk', 'ЗАСТАРІЛЕ') }
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

describe('bilingual transcript modal integration', () => {
  let reduced = false;
  const motionListeners = new Set<() => void>();

  beforeEach(() => {
    reduced = false;
    motionListeners.clear();
    // The document cache is module-wide; one test's document must not be the next one's.
    forgetTranscriptDocuments();
    api.transcriptionDocument.mockReset().mockResolvedValue(documentFixture);
    api.transcriptionTranslate.mockReset();
    api.transcriptionTranslation.mockReset();
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

  it('is read by keyboard before playback: one stop per column, arrows between segments, Enter opens the player there', async () => {
    api.transcriptionTranslation.mockResolvedValue(translated('uk', 'Привіт, світе.', 6));
    api.transcriptionTranslate.mockResolvedValue(translated('uk', 'Привіт, світе.', 6));
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
          translatorModel={installedModel}
          onInstallTranslator={() => {}}
          onCancelTranslator={() => {}}
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

  it('revalidates cache, mirrors selection/copy, switches RTL race-safely, and preserves it through preview', async () => {
    const uk = translated('uk', 'Привіт, світе.', 6);
    let resolveArabic!: (value: TranslationDocument) => void;
    const arabicPromise = new Promise<TranslationDocument>(resolve => {
      resolveArabic = resolve;
    });
    api.transcriptionTranslate.mockImplementation(async (_jobId: string, language: string) =>
      language === 'ar' ? arabicPromise : uk
    );
    api.transcriptionTranslation.mockResolvedValue(uk);

    const onClose = vi.fn();
    const returnFocus = document.createElement('button');
    document.body.append(returnFocus);
    const view = render(
      <TranscriptTextModal
        job={job}
        language="uk"
        returnFocus={returnFocus}
        translatorModel={installedModel}
        onInstallTranslator={vi.fn()}
        onCancelTranslator={vi.fn()}
        onClose={onClose}
        t={t}
      />
    );

    expect(await screen.findByText('Привіт, світе.')).not.toBeNull();
    expect(screen.queryByText('ЗАСТАРІЛЕ')).toBeNull();
    expect(api.transcriptionTranslate).toHaveBeenCalledWith(job.id, 'uk', expect.any(String));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('textarea,[contenteditable="true"]')).toBeNull();
    expect(dialog.querySelectorAll('.transcript-column')).toHaveLength(2);

    const source = dialog.querySelector<HTMLElement>('[data-side="source"]')!;
    const target = dialog.querySelector<HTMLElement>('[data-side="target"]')!;
    // The direction sits on the transcript text, not on the column whose loading and
    // failure sentences are in the interface language.
    const textDirection = (column: HTMLElement) =>
      column.querySelector<HTMLElement>('.transcript-column-text, .transcript-translation-content')
        ?.dir;
    expect(source.dir).toBe('');
    expect(textDirection(source)).toBe('ltr');
    expect(textDirection(target)).toBe('ltr');

    fireEvent.click(within(source).getByRole('button', { name: 'Copy all' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('Hello world.')
    );
    fireEvent.click(within(target).getByRole('button', { name: 'Copy all' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('Привіт, світе.')
    );

    const firstWord = source.querySelector<HTMLElement>('[data-word-id="word-1"]')!;
    const range = document.createRange();
    range.selectNodeContents(firstWord);
    const native = window.getSelection()!;
    native.removeAllRanges();
    native.addRange(range);
    fireEvent.pointerUp(dialog.querySelector('.transcript-split-body')!);
    await waitFor(() => {
      expect(source.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);
      expect(target.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/Exact · 96%/u)).not.toBeNull();

    fireEvent.click(within(source).getByRole('button', { name: 'Copy selection' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('Hello'));
    fireEvent.click(within(target).getByRole('button', { name: 'Copy selection' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('Привіт'));
    expect(source.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);

    reduced = true;
    act(() => {
      for (const listener of motionListeners) listener();
    });
    const combobox = within(target).getByRole('combobox');
    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: 'араб' } });
    fireEvent.click(await within(target).findByRole('option', { name: /Арабська/u }));
    await waitFor(() => expect(target.getAttribute('aria-busy')).toBe('true'));
    // The previous translation stays fully readable while the new target is
    // translating — segments stream in progressively, no blur overlay.
    expect(
      target
        .querySelector('.transcript-translation-content')
        ?.classList.contains('is-translating-static')
    ).toBe(false);
    expect(target.textContent).toContain('Привіт, світе.');

    await act(async () => {
      resolveArabic(translated('ar', 'مرحبا بالعالم.', 5));
      await arabicPromise;
    });
    await waitFor(() => expect(target.textContent).toContain('مرحبا بالعالم.'));
    expect(target.dir).toBe('');
    expect(textDirection(target)).toBe('rtl');
    expect(source.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);
    expect(target.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /^(Preview|Play sound)$/u }));
    const media = await waitFor(() => {
      const element = dialog.querySelector('video');
      expect(element).not.toBeNull();
      return element!;
    });
    // The player's source is a ticketed subresource URL now, not the session
    // token in a query string: what matters is that it points at this job's
    // media and carries a ticket rather than a credential.
    await waitFor(() => expect(media.src).toContain('/media'));
    expect(media.src).toContain('ticket=');
    expect(media.src).not.toContain('token=');
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(source.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(source.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(source.querySelectorAll('.ts-selected')).toHaveLength(0));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    view.unmount();
    expect(document.activeElement).toBe(returnFocus);
    returnFocus.remove();
  });
});
