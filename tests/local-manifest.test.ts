// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { buildLocalManifest } from '../apps/web/src/team/explorer/localManifest';
import {
  isLocalManifestMetadata,
  isLocalManifestRelativePath,
  isLocalOperationStage,
  isLocalOperationState
} from '../packages/shared/src/team/transport';
import {
  dropDirectory,
  dropFile,
  handleDirectory,
  handleFile,
  localFile
} from './fixtures/local-manifest';

describe('local transfer manifest', () => {
  it('keeps mixed roots, original names, zero-byte files and explicit empty directories', async () => {
    const campaign = handleDirectory('Кампанія', [
      handleDirectory('Порожня'),
      handleDirectory('UA', [handleFile(localFile('Лікарі.png', 0))])
    ]);
    const result = await buildLocalManifest([
      { kind: 'directory_handle', handle: campaign },
      { kind: 'file', file: localFile('cover.jpg') }
    ]);
    expect(result.issues).toEqual([]);
    expect(result.entries.map(entry => [entry.kind, entry.relativePath])).toEqual([
      ['directory', 'Кампанія'],
      ['file', 'cover.jpg'],
      ['directory', 'Кампанія/Порожня'],
      ['directory', 'Кампанія/UA'],
      ['file', 'Кампанія/UA/Лікарі.png']
    ]);
    expect(result.totalFiles).toBe(2);
    expect(result.totalDirectories).toBe(3);
    expect(result.totalBytes).toBe(1);
  });

  it('exhausts every dropped directory reader batch', async () => {
    const result = await buildLocalManifest([
      {
        kind: 'drop_entry',
        entry: dropDirectory('root', [
          [dropFile(localFile('a.txt'))],
          [dropDirectory('empty', [])],
          [dropFile(localFile('b.txt'))]
        ])
      }
    ]);
    expect(result.entries.map(entry => entry.relativePath)).toEqual([
      'root',
      'root/a.txt',
      'root/empty',
      'root/b.txt'
    ]);
    expect(result.issues).toEqual([]);
  });

  it('compares Unicode-normalized names without changing the displayed spelling', async () => {
    const name = 'Cafe\u0301';
    const result = await buildLocalManifest([{ kind: 'file', file: localFile(name) }]);
    expect(result.entries[0]?.relativePath).toBe(name);
    expect(result.entries[0]?.comparisonPath).toBe('Café');
  });

  it('reports repeated or cyclic directory handles without traversing forever', async () => {
    const cycle = handleDirectory('loop');
    const children = [cycle];
    const root = handleDirectory('root', children);
    children.push(root);
    const result = await buildLocalManifest([{ kind: 'directory_handle', handle: root }]);
    expect(result.issues.some(issue => issue.code === 'CYCLE')).toBe(true);
    expect(result.entries).toHaveLength(2);
  });

  it('enforces entry limits before remote mutation and does not truncate silently', async () => {
    const root = handleDirectory(
      'root',
      Array.from({ length: 1001 }, (_, index) => handleFile(localFile(`f-${index}.txt`)))
    );
    const result = await buildLocalManifest([{ kind: 'directory_handle', handle: root }]);
    expect(result.totalFiles).toBe(1000);
    expect(result.issues.some(issue => issue.code === 'LIMIT_EXCEEDED')).toBe(true);
  });

  it('records unreadable branches and cancellation as explicit issues', async () => {
    const broken = handleDirectory('root', [
      {
        kind: 'file',
        name: 'broken.txt',
        getFile: async () => {
          throw new Error('denied');
        }
      }
    ]);
    const partial = await buildLocalManifest([{ kind: 'directory_handle', handle: broken }]);
    expect(partial.issues).toMatchObject([{ code: 'UNREADABLE', relativePath: 'root/broken.txt' }]);
    const controller = new AbortController();
    controller.abort();
    const canceled = await buildLocalManifest([{ kind: 'directory_handle', handle: broken }], {
      signal: controller.signal
    });
    expect(canceled.issues).toMatchObject([{ code: 'CANCELED' }]);
    expect(canceled.entries).toEqual([]);
  });

  it('rejects traversal, absolute paths, and File/handle objects at the metadata boundary', async () => {
    const manifest = await buildLocalManifest([{ kind: 'file', file: localFile('safe.txt') }]);
    const fileEntry = manifest.entries[0]!;
    expect(isLocalManifestMetadata(fileEntry)).toBe(false);
    const metadata = Object.fromEntries(
      Object.entries(fileEntry).filter(([key]) => key !== 'source')
    );
    expect(isLocalManifestMetadata(metadata)).toBe(true);
    expect(isLocalManifestMetadata({ ...metadata, handle: {} })).toBe(false);
    expect(isLocalManifestMetadata({ ...metadata, relativePath: '../escape.txt' })).toBe(false);
    expect(isLocalManifestRelativePath('/Users/me/secret.txt')).toBe(false);
    expect(isLocalManifestRelativePath('C:/secret.txt')).toBe(false);
    expect(isLocalManifestRelativePath('a\\secret.txt')).toBe(false);
    expect(isLocalOperationState('interrupted_input_required')).toBe(true);
    expect(isLocalOperationState('uploaded')).toBe(false);
    expect(isLocalOperationStage('updating_catalog')).toBe(true);
    expect(isLocalOperationStage('percent_done')).toBe(false);
  });
});
