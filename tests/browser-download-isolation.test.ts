// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { handoffBrowserDownload } from '../apps/web/src/team/materials/browser-download';

afterEach(() => vi.restoreAllMocks());

it('hands signed downloads to a separate browsing context without an opener or a workspace navigation', () => {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push(this);
  });
  handoffBrowserDownload('https://download.example/opaque-ticket', 'original.mp4');
  handoffBrowserDownload('https://download.example/other-ticket', 'other.mp4');
  expect(clicked).toHaveLength(2);
  for (const anchor of clicked) {
    expect(anchor.target).toBe('_blank');
    expect(anchor.relList.contains('noopener')).toBe(true);
    expect(anchor.relList.contains('noreferrer')).toBe(true);
  }
  expect(clicked[0]!.download).toBe('original.mp4');
  expect(clicked[1]!.download).toBe('other.mp4');
  expect(document.querySelector('a')).toBeNull();
});
