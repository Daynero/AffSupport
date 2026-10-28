// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { downloadTranscriptExport } from '../apps/web/src/transcription/export';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('hands the transcript to the browser before revoking its temporary URL', () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn().mockReturnValue('blob:synthetic-transcript');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    expect(this.isConnected).toBe(true);
    expect(this.download).toBe('clip.txt');
    expect(this.href).toBe('blob:synthetic-transcript');
    expect(this.rel).toBe('noopener');
  });
  downloadTranscriptExport({
    name: 'clip.txt',
    mimeType: 'text/plain;charset=utf-8',
    text: 'Привіт'
  });
  expect(click).toHaveBeenCalledOnce();
  const blob = createObjectURL.mock.calls[0]![0] as Blob;
  expect(blob.type).toBe('text/plain;charset=utf-8');
  expect(blob.size).toBe(new TextEncoder().encode('Привіт').length);
  expect(document.querySelector('a[download]')).toBeNull();
  vi.advanceTimersByTime(9_999);
  expect(revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-transcript');
});
