import { describe, expect, it } from 'vitest';
import { parseReviewHash, serializeReviewRoute } from '../apps/soty-review/src/review/router.js';

describe('Soty review hash router', () => {
  it('round-trips validated screen state', () => {
    const route = parseReviewHash('#/screen/compressor?state=active&theme=dark&locale=en-long');
    expect(route).toMatchObject({
      kind: 'screen',
      surfaceId: 'compressor',
      stateId: 'active',
      theme: 'dark',
      locale: 'en-long'
    });
    expect(parseReviewHash(serializeReviewRoute(route))).toEqual(route);
  });

  it('returns to catalog for untrusted or unknown input', () => {
    expect(parseReviewHash({})).toMatchObject({ kind: 'catalog', notice: expect.any(String) });
    expect(parseReviewHash('#/screen/not-real?state=active')).toMatchObject({
      kind: 'catalog',
      notice: expect.any(String)
    });
    expect(parseReviewHash('#/screen/compressor?state=not-real')).toMatchObject({
      kind: 'catalog',
      notice: expect.any(String)
    });
  });
});
