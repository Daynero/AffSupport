// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  transcriptionClearFinished: vi.fn(),
  transcriptionDocument: vi.fn(),
  transcriptionEventUrl: vi.fn(() => '/events'),
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
vi.mock('../apps/web/src/AgentContext.js', () => ({
  useAgent: () => ({
    connection: 'connected',
    connectedOnce: true,
    reconnect: vi.fn(),
    capabilities: ['local-file-paths']
  })
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

function transcript(jobId: string, text: string): TranscriptionDocument {
  return {
    jobId,
    sourceLanguage: 'uk',
    modelVersion: 'test',
    segments: [
      {
        id: `${jobId}-segment`,
        startMs: 0,
        endMs: 1,
        sourceText: text,
        words: []
      }
    ],
    translations: {}
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
  settings: { language: 'uk' }
};

class EventSourceStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close() {}
}

beforeEach(() => {
  localStorage.setItem('language', 'uk');
  vi.stubGlobal('EventSource', EventSourceStub);
  api.request.mockReset().mockResolvedValue(state);
  api.transcriptionDocument
    .mockReset()
    .mockImplementation((id: string) =>
      Promise.resolve(transcript(id, id === 'newer' ? 'Новіший текст.' : 'Старіший текст.'))
    );
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
  it('places Copy all below the list and copies only completed transcripts in display order', async () => {
    render(<TranscriptionPage />);

    const button = await screen.findByRole('button', { name: 'Копіювати всі' });
    const list = document.querySelector('.video-list');
    expect(list?.nextElementSibling?.classList.contains('transcription-list-actions')).toBe(true);
    expect(screen.getByText(/вашому комп’ютері/)).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'Транскрибування 1:\nНовіший текст.\n\n' + 'Транскрибування 2:\nСтаріший текст.'
      )
    );
    expect(api.transcriptionDocument).toHaveBeenCalledTimes(2);
    expect(api.transcriptionDocument).not.toHaveBeenCalledWith('waiting');
    expect(api.transcriptionDocument).not.toHaveBeenCalledWith('silent');
  });
});
