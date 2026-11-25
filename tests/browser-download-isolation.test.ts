// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  handoffBrowserDownload,
  saveBytesAsDownload
} from '../apps/web/src/team/materials/browser-download';

afterEach(() => vi.restoreAllMocks());

function clicks() {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push(this);
  });
  return clicked;
}

it('saves without a new tab, an opener or a workspace navigation, even for another origin', () => {
  // Safari ignores `download` on another origin and opens the file; a `_blank` there was a tab
  // per click that started playing the video (073, owner 2026-11-25).
  const clicked = clicks();
  handoffBrowserDownload('https://download.example/opaque-ticket', 'original.mp4');
  handoffBrowserDownload('https://download.example/other-ticket', 'other.mp4');
  expect(clicked).toHaveLength(2);
  for (const anchor of clicked) {
    expect(anchor.target).toBe('');
    expect(anchor.relList.contains('noopener')).toBe(true);
    expect(anchor.relList.contains('noreferrer')).toBe(true);
  }
  expect(clicked[0]!.download).toBe('original.mp4');
  expect(clicked[1]!.download).toBe('other.mp4');
  expect(document.querySelector('a')).toBeNull();
});

it('hands the bytes to the browser as a same-origin blob and lets it go afterwards', () => {
  vi.useFakeTimers();
  const clicked = clicks();
  const revoke = vi.fn();
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local'), revokeObjectURL: revoke });
  saveBytesAsDownload(Uint8Array.from([1, 2, 3]), 'clip.mp4', 'video/mp4');
  expect(clicked[0]!.href).toBe('blob:local');
  expect(clicked[0]!.target).toBe('');
  expect(revoke).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(revoke).toHaveBeenCalledWith('blob:local');
  vi.useRealTimers();
});
