// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { collectDroppedLandings } from '../apps/web/src/landing/LandingOptimizerPage';

describe('landing multi-drop', () => {
  it('collects multiple ZIP archives and folders from one drop', async () => {
    const firstZip = new File(['zip-one'], 'first.zip', { type: 'application/zip' });
    const secondZip = new File(['zip-two'], 'second.zip', { type: 'application/zip' });
    const firstImage = new File(['image-one'], 'hero.jpg', { type: 'image/jpeg' });
    const secondImage = new File(['image-two'], 'logo.svg', { type: 'image/svg+xml' });
    const entries = [
      fileEntry(firstZip),
      directoryEntry('campaign-one', [fileEntry(firstImage)]),
      fileEntry(secondZip),
      directoryEntry('campaign-two', [fileEntry(secondImage)])
    ];
    const transfer = {
      items: entries.map(entry => ({ webkitGetAsEntry: () => entry })),
      files: []
    } as unknown as DataTransfer;

    const payloads = await collectDroppedLandings(transfer);

    expect(payloads.map(payload => payload.kind)).toEqual(['zip', 'folder', 'zip', 'folder']);
    expect(
      payloads.filter(payload => payload.kind === 'zip').map(payload => payload.file.name)
    ).toEqual(['first.zip', 'second.zip']);
    expect(
      payloads
        .filter(payload => payload.kind === 'folder')
        .map(payload => ({ name: payload.name, paths: payload.files.map(file => file.relPath) }))
    ).toEqual([
      { name: 'campaign-one', paths: ['campaign-one/hero.jpg'] },
      { name: 'campaign-two', paths: ['campaign-two/logo.svg'] }
    ]);
  });
});

function fileEntry(file: File): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath: `/${file.name}`,
    filesystem: {} as FileSystem,
    getParent: () => undefined,
    file: callback => callback(file)
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(name: string, entries: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    filesystem: {} as FileSystem,
    getParent: () => undefined,
    createReader: () => {
      const batches = [entries, []];
      return {
        readEntries: callback => callback(batches.shift() ?? [])
      } as FileSystemDirectoryReader;
    },
    getFile: () => undefined,
    getDirectory: () => undefined
  } as unknown as FileSystemDirectoryEntry;
}
