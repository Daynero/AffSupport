import { describe, expect, it, vi } from 'vitest';
import { healModuleGraph, moduleReferences } from '../apps/web/src/lib/healModuleCache';

// next 2026-11-21: ProtectedSoty loaded, but one of its imports (PfMHdMvx2.js) was the page's
// HTML in the browser's cache; refetching the failed module alone never healed it.

const ORIGIN = 'https://next.example.test';
const files: Record<string, string> = {
  '/assets/ProtectedSoty-1.js':
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/Lazy-2.js","assets/Lazy-2.css"])))=>i.map(i=>d[i]);' +
    'import{a}from"./PfMHdMvx2.js";import"./Shared-3.js";',
  '/assets/PfMHdMvx2.js': 'import{b}from"./Deep-4.js";export const a=1;',
  '/assets/Shared-3.js': 'export const s=1;',
  '/assets/Deep-4.js': 'import{x}from"https://cdn.example.test/x.js";export const b=1;',
  '/assets/Lazy-2.js': 'export default 1;',
  '/assets/Lazy-2.css': '.x{}'
};

describe('moduleReferences', () => {
  it('finds relative imports and the preload map, and only same-origin assets', () => {
    const refs = moduleReferences(
      files['/assets/ProtectedSoty-1.js']!,
      `${ORIGIN}/assets/ProtectedSoty-1.js`,
      ORIGIN
    );
    expect(refs.sort()).toEqual(
      [
        `${ORIGIN}/assets/Lazy-2.js`,
        `${ORIGIN}/assets/Lazy-2.css`,
        `${ORIGIN}/assets/PfMHdMvx2.js`,
        `${ORIGIN}/assets/Shared-3.js`
      ].sort()
    );
    expect(
      moduleReferences(files['/assets/Deep-4.js']!, `${ORIGIN}/assets/Deep-4.js`, ORIGIN)
    ).toEqual([]);
  });
});

describe('healModuleGraph', () => {
  it('fetches the failed module and every file under it again, past the cache', async () => {
    const fetchImpl = vi.fn(async (href: string, init?: RequestInit) => {
      expect(init?.cache).toBe('reload');
      const body = files[new URL(href).pathname];
      return new Response(body ?? '', { status: body === undefined ? 404 : 200 });
    });
    const count = await healModuleGraph(`${ORIGIN}/assets/ProtectedSoty-1.js`, {
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const fetched = fetchImpl.mock.calls.map(([href]) => new URL(href).pathname).sort();
    expect(fetched).toEqual(Object.keys(files).sort());
    expect(count).toBe(Object.keys(files).length);
  });

  it('stops at its limit and never leaves the origin', async () => {
    const fetchImpl = vi.fn(async (href: string) => {
      const n = Number(/(\d+)\.js$/u.exec(href)?.[1] ?? 0);
      return new Response(`import"./m${n + 1}.js";`);
    });
    const count = await healModuleGraph(`${ORIGIN}/assets/m0.js`, {
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limit: 5
    });
    expect(count).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(
      await healModuleGraph('https://elsewhere.test/assets/a.js', {
        origin: ORIGIN,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).toBe(0);
  });
});
