// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptionModelInfo,
  TranscriptionState
} from '@video-compressor/shared';

const api = vi.hoisted(() => ({
  request: vi.fn(),
  transcriptionAddLocalFiles: vi.fn(),
  transcriptionCancel: vi.fn(),
  transcriptionCancelAll: vi.fn(),
  transcriptionClearFinished: vi.fn(),
  transcriptionDocument: vi.fn(),
  toolEventUrl: vi.fn(() => '/events'),
  transcriptionMediaCancel: vi.fn(),
  transcriptionMediaPrepare: vi.fn(),
  transcriptionMediaStatus: vi.fn(),
  transcriptionMediaUrl: vi.fn(() => '/media'),
  transcriptionModelCancel: vi.fn(),
  transcriptionModelDownload: vi.fn(),
  transcriptionRemove: vi.fn(),
  transcriptionRetry: vi.fn(),
  transcriptionReveal: vi.fn(),
  transcriptionSelect: vi.fn(),
  transcriptionSettings: vi.fn(),
  transcriptionStart: vi.fn(),
  transcriptionTranslate: vi.fn(),
  transcriptionTranslation: vi.fn(),
  transcriptionTranslatorCancel: vi.fn(),
  transcriptionTranslatorDownload: vi.fn(),
  transcriptionUpload: vi.fn()
}));

vi.mock('../apps/web/src/api/client.js', () => api);
/** Mutable, so a test can mount the page before the agent has answered and then connect. */
const agent = vi.hoisted(() => ({
  connection: 'connected' as 'checking' | 'connected' | 'disconnected',
  connectedOnce: true,
  reconnect: vi.fn(),
  capabilities: ['local-file-paths']
}));
vi.mock('../apps/web/src/AgentContext.js', () => ({
  useAgent: () => ({ ...agent })
}));
vi.mock('../apps/web/src/App.js', async () => {
  const ReactModule = await import('react');
  return {
    Header: () => ReactModule.createElement('header'),
    Onboarding: () => null
  };
});
vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: {
    setLocale: vi.fn(),
    track: vi.fn()
  }
}));

import TranscriptionPage from '../apps/web/src/transcription/TranscriptionPage.js';
import { forgetTranscriptDocuments } from '../apps/web/src/transcription/document-cache.js';

const installedModel: TranscriptionModelInfo = {
  present: true,
  downloading: false,
  progress: 100,
  sizeBytes: 1,
  downloadedBytes: 1,
  label: 'installed',
  error: null
};

function job(id: string, createdAt: number, status: TranscriptionJob['status']): TranscriptionJob {
  return {
    id,
    inputPath: '',
    fileName: `${id}.mp4`,
    sourceKind: 'local',
    sourceKey: null,
    durationSeconds: 1,
    status,
    progress: status === 'completed' ? 100 : null,
    requestedLanguage: 'uk',
    detectedLanguage: status === 'completed' ? 'uk' : null,
    text: null,
    characters: status === 'completed' ? 10 : null,
    error: null,
    errorDetails: null,
    batchId: null,
    createdAt,
    startedAt: status === 'completed' ? createdAt + 1 : null,
    finishedAt: status === 'completed' ? createdAt + 2 : null
  };
}

function transcript(
  jobId: string,
  text: string,
  translated: string | null = null
): TranscriptionDocument {
  const segmentId = `${jobId}-segment`;
  return {
    jobId,
    sourceLanguage: 'uk',
    modelVersion: 'test',
    segments: [
      {
        id: segmentId,
        startMs: 0,
        endMs: 1,
        sourceText: text,
        words: []
      }
    ],
    translations: translated
      ? {
          en: {
            targetLanguage: 'en',
            modelVersion: 'test',
            status: 'completed',
            segments: [{ sourceSegmentId: segmentId, translatedText: translated, alignments: [] }],
            error: null
          }
        }
      : {}
  };
}

const state: TranscriptionState = {
  jobs: [
    job('older', 1, 'completed'),
    job('newer', 2, 'completed'),
    job('waiting', 3, 'ready'),
    { ...job('silent', 4, 'completed'), characters: 0 }
  ],
  running: false,
  tools: { ffmpeg: true, whisper: true, model: true },
  model: installedModel,
  translatorModel: installedModel,
  translatorRuntime: installedModel,
  alignmentModel: installedModel,
  settings: { language: 'uk', translationLanguage: 'uk', quality: 'fast' }
};

class EventSourceStub {
  static latest: EventSourceStub | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    EventSourceStub.latest = this;
  }
  close() {}
  /** What the agent would push: one frame carrying the whole state. */
  push(next: TranscriptionState) {
    this.onmessage?.({
      data: JSON.stringify({ type: 'transcription:state', state: next })
    } as MessageEvent);
  }
}

beforeEach(() => {
  // Documents are remembered across renders of the page; a test starts with none.
  forgetTranscriptDocuments();
  localStorage.setItem('language', 'uk');
  vi.stubGlobal('EventSource', EventSourceStub);
  api.request.mockReset().mockResolvedValue(state);
  api.transcriptionStart.mockReset().mockResolvedValue(state);
  api.transcriptionCancelAll.mockReset().mockResolvedValue(state);
  api.transcriptionDocument
    .mockReset()
    .mockImplementation((id: string) =>
      Promise.resolve(
        id === 'newer'
          ? transcript(id, 'Новіший текст.', 'Newer text.')
          : transcript(id, 'Старіший текст.')
      )
    );
  api.transcriptionSettings.mockReset().mockResolvedValue(state);
  api.transcriptionTranslate.mockReset().mockResolvedValue({
    targetLanguage: 'en',
    modelVersion: 'test',
    status: 'queued',
    totalSegments: 1,
    completedSegments: 0,
    segments: [],
    error: null
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('transcription page batch copy', () => {
  it('copies finished transcripts with their translations from the toolbar', async () => {
    render(<TranscriptionPage />);

    const button = await screen.findByRole('button', { name: 'Копіювати завершені (2)' });
    // The control belongs to the queue toolbar above the list, not below it.
    expect(button.closest('.batch-toolbar')).not.toBeNull();
    expect(document.querySelector('.transcription-list-actions')).toBeNull();
    expect(screen.getByText(/вашому комп’ютері/)).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'Транскрипція 1: newer.mp4\n' +
          'Транскрипція:\nНовіший текст.\n\n' +
          'Переклад (Англійська):\nNewer text.\n\n' +
          'Транскрипція 2: older.mp4\n' +
          'Транскрипція:\nСтаріший текст.'
      )
    );
    expect(api.transcriptionDocument).toHaveBeenCalledTimes(2);
    expect(api.transcriptionDocument).not.toHaveBeenCalledWith('waiting');
    expect(api.transcriptionDocument).not.toHaveBeenCalledWith('silent');
  });

  it('switches the copy scope and content through the dropdown', async () => {
    render(<TranscriptionPage />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Вибрати newer.mp4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Параметри копіювання' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Вибрані (1)' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Лише переклад' }));

    fireEvent.click(screen.getByRole('button', { name: 'Копіювати вибрані (1)' }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'Транскрипція 1: newer.mp4 · Переклад (Англійська)\nNewer text.'
      )
    );
    expect(api.transcriptionDocument).toHaveBeenCalledTimes(1);
  });

  it('warns instead of copying when the chosen content is missing everywhere', async () => {
    api.request.mockResolvedValue({ ...state, jobs: [job('older', 1, 'completed')] });
    render(<TranscriptionPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Параметри копіювання' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Лише переклад' }));
    fireEvent.click(screen.getByRole('button', { name: 'Копіювати завершені (1)' }));

    expect(await screen.findByText('З цими параметрами копіювати нічого')).toBeTruthy();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('shows subtle translation progress and restarts it when the row language changes', async () => {
    const translatingJob: TranscriptionJob = {
      ...job('translated', 5, 'completed'),
      requestedLanguage: 'auto',
      detectedLanguage: 'en',
      translation: {
        targetLanguage: 'uk',
        status: 'processing',
        progress: 25,
        completedSegments: 1,
        totalSegments: 4,
        error: null
      }
    };
    api.request.mockResolvedValue({ ...state, jobs: [translatingJob] });

    render(<TranscriptionPage />);

    expect(await screen.findByText('Перекладаємо')).toBeTruthy();
    const combobox = screen.getByRole('combobox', { name: 'Перекласти на' }) as HTMLInputElement;
    // The row's picker shows the language by name; the code stays behind it.
    expect(combobox.value).toBe('Українська');
    expect(
      screen
        .getByRole('progressbar', { name: 'Переклад файлу translated.mp4' })
        .getAttribute('aria-valuenow')
    ).toBe('25');

    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: 'нім' } });
    // Scoped to the picker's own list: the spoken-language select lists the same names.
    fireEvent.click(
      await within(await screen.findByRole('listbox')).findByRole('option', { name: 'Німецька' })
    );

    expect(combobox.value).toBe('Німецька');
    await waitFor(() =>
      expect(api.transcriptionTranslate).toHaveBeenCalledWith('translated', 'de')
    );
  });
});

describe('re-transcribing and stopping the queue', () => {
  it('transcribes a finished file again from its row', async () => {
    render(<TranscriptionPage />);

    const rows = await screen.findAllByRole('article');
    const repeat = within(rows[0]).getByRole('button', { name: 'Транскрибувати знову' });
    fireEvent.click(repeat);

    await waitFor(() => expect(api.transcriptionStart).toHaveBeenCalledWith(['silent']));
  });

  it('transcribes the selected files, finished ones included', async () => {
    render(<TranscriptionPage />);

    const selected = await screen.findByRole('checkbox', { name: 'Вибрати newer.mp4' });
    fireEvent.click(selected);

    // The primary action names the selection and how many of it can run; there is no
    // separate "1 selected" line, the button is the count.
    fireEvent.click(screen.getByRole('button', { name: 'Транскрибувати вибрані (1)' }));

    await waitFor(() => expect(api.transcriptionStart).toHaveBeenCalledWith(['newer']));
  });

  it('offers Stop all only while something is running and stops the whole queue', async () => {
    render(<TranscriptionPage />);

    await screen.findByRole('button', { name: 'Транскрибувати все' });
    expect(screen.queryByRole('button', { name: 'Зупинити все' })).toBeNull();

    cleanup();
    api.request.mockResolvedValue({
      ...state,
      running: true,
      jobs: [job('running', 6, 'processing'), job('waiting', 7, 'queued')]
    });
    render(<TranscriptionPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Зупинити все' }));
    await waitFor(() => expect(api.transcriptionCancelAll).toHaveBeenCalled());
  });
});

describe('live updates', () => {
  it('applies newer frames, drops stale ones, and accepts a restarted agent', async () => {
    api.request.mockResolvedValue({ ...state, revision: 10, instance: 'run-one' });
    render(<TranscriptionPage />);
    await screen.findByText('older.mp4');
    const stream = EventSourceStub.latest!;

    // A frame from the same run with a higher revision is shown.
    await act(async () => {
      stream.push({
        ...state,
        revision: 11,
        instance: 'run-one',
        jobs: [job('fresh', 9, 'ready')]
      });
    });
    expect(await screen.findByText('fresh.mp4')).toBeTruthy();
    expect(screen.queryByText('older.mp4')).toBeNull();

    // An older frame from the same run — a request that raced the stream — is not.
    await act(async () => {
      stream.push({ ...state, revision: 5, instance: 'run-one', jobs: [job('stale', 1, 'ready')] });
    });
    expect(screen.queryByText('stale.mp4')).toBeNull();

    // The agent restarted: its numbers start over, and the first frame of the new run wins
    // whatever its number says. This used to freeze the page on the old run's last state.
    await act(async () => {
      stream.push({
        ...state,
        revision: 1,
        instance: 'run-two',
        jobs: [job('after-restart', 2, 'ready')]
      });
    });
    expect(await screen.findByText('after-restart.mp4')).toBeTruthy();
  });
});

describe('mounting before the agent answers', () => {
  it('renders the checking state, then the page, without a hooks mismatch', async () => {
    agent.connection = 'checking';
    agent.connectedOnce = false;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const view = render(<TranscriptionPage />);
      expect(screen.queryByRole('checkbox', { name: 'Вибрати все' })).toBeNull();
      agent.connection = 'connected';
      agent.connectedOnce = true;
      view.rerender(<TranscriptionPage />);
      await screen.findByRole('checkbox', { name: 'Вибрати все' });
      // "Rendered more hooks than during the previous render" arrives through console.error.
      expect(errors.mock.calls.map(call => String(call[0]))).not.toContainEqual(
        expect.stringContaining('hooks')
      );
      view.unmount();
    } finally {
      errors.mockRestore();
      agent.connection = 'connected';
      agent.connectedOnce = true;
    }
  });
});
