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
    expect(source.dir).toBe('ltr');
    expect(target.dir).toBe('ltr');

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
    expect(target.dir).toBe('rtl');
    expect(source.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);
    expect(target.querySelectorAll('.ts-selected').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
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
