import { describe, expect, it } from 'vitest';
import { exclusiveLazyRouteAssets, sumAssetBytes } from '../scripts/lib/lazy-route-assets.mjs';

function fixture() {
  return {
    'index.html': {
      file: 'assets/index.js',
      isEntry: true,
      imports: ['shared'],
      dynamicImports: ['accounts', 'launches']
    },
    shared: { file: 'assets/shared.js', css: ['assets/shared.css'] },
    accounts: {
      file: 'assets/accounts.js',
      isDynamicEntry: true,
      imports: ['shared', 'drag'],
      dynamicImports: ['archive'],
      css: ['assets/accounts.css', 'assets/shared.css']
    },
    drag: { file: 'assets/drag.js' },
    archive: { file: 'assets/archive.js', isDynamicEntry: true, imports: ['shared', 'drag'] },
    launches: { file: 'assets/launches.js', isDynamicEntry: true, imports: ['shared'] }
  };
}

describe('exclusive lazy-route budget graph', () => {
  it('includes real secondary lazy views and dependencies but excludes shared JS/CSS', () => {
    expect(exclusiveLazyRouteAssets(fixture(), 'accounts')).toEqual({
      rootFile: 'assets/accounts.js',
      files: ['assets/accounts.css', 'assets/accounts.js', 'assets/archive.js', 'assets/drag.js'],
      reachableFiles: [
        'assets/accounts.css',
        'assets/accounts.js',
        'assets/archive.js',
        'assets/drag.js',
        'assets/shared.css',
        'assets/shared.js'
      ],
      sharedFiles: ['assets/shared.css', 'assets/shared.js']
    });
  });

  it('charges a dependency to global costs once another route uses it', () => {
    const manifest = fixture();
    manifest.launches.imports.push('drag');
    expect(exclusiveLazyRouteAssets(manifest, 'accounts').files).not.toContain('assets/drag.js');
  });

  it('does not exempt a secondary view separately reachable from another route', () => {
    const manifest = fixture();
    manifest.launches.imports.push('archive');
    expect(exclusiveLazyRouteAssets(manifest, 'accounts').files).toEqual([
      'assets/accounts.css',
      'assets/accounts.js'
    ]);
  });

  it('handles circular imports without double counting and deduplicates CSS', () => {
    const manifest = fixture();
    manifest.drag = { ...manifest.drag, ...{ imports: ['accounts'] } };
    expect(exclusiveLazyRouteAssets(manifest, 'accounts').files).toHaveLength(4);
    expect(sumAssetBytes(['a', 'a', 'b'], file => (file === 'a' ? 12 : 7))).toBe(19);
  });

  it('keeps dependencies reached by a second HTML entry global', () => {
    const manifest = {
      ...fixture(),
      'other.html': { file: 'assets/other.js', isEntry: true, imports: ['drag'] }
    };
    expect(exclusiveLazyRouteAssets(manifest, 'accounts').sharedFiles).toContain('assets/drag.js');
  });

  it('fails closed for a route imported statically from another route', () => {
    const manifest = fixture();
    manifest.launches.imports.push('accounts');
    expect(() => exclusiveLazyRouteAssets(manifest, 'accounts')).toThrow('statically reachable');
  });

  it('fails for missing dependencies, absent entry roots or disconnected lazy routes', () => {
    expect(() => exclusiveLazyRouteAssets({ accounts: fixture().accounts }, 'accounts')).toThrow(
      'Missing manifest dependency'
    );
    expect(() =>
      exclusiveLazyRouteAssets({ a: { file: 'a.js', isDynamicEntry: true } }, 'a')
    ).toThrow('no application entry');
    expect(() =>
      exclusiveLazyRouteAssets(
        { ...fixture(), orphan: { file: 'orphan.js', isDynamicEntry: true } },
        'orphan'
      )
    ).toThrow('unreachable');
  });

  it('rejects malformed graph records and unsafe output paths', () => {
    for (const manifest of [
      null,
      [],
      { a: null },
      { a: { file: '../outside.js' } },
      { a: { file: 'a.js', imports: 'b' } }
    ]) {
      expect(() => exclusiveLazyRouteAssets(manifest, 'a')).toThrow();
    }
    expect(() => exclusiveLazyRouteAssets(fixture(), 'shared')).toThrow('Expected a lazy route');
    expect(() => sumAssetBytes(['a'], () => NaN)).toThrow('Invalid measured asset size');
  });
});
