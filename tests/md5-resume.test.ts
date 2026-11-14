import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Md5 } from '../supabase/functions/_shared/md5';

describe('durable MD5 prefix', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 4096, 8193])(
    'resumes at byte %i against an independent implementation',
    split => {
      const bytes = Uint8Array.from({ length: 10001 }, (_, i) => (i * 73 + (i >>> 3)) & 255);
      const digest = new Md5().update(bytes.subarray(0, split));
      const snapshot = JSON.parse(JSON.stringify(digest.snapshot()));
      expect(digest.digest()).toBe(
        createHash('md5').update(bytes.subarray(0, split)).digest('hex')
      );
      expect(digest.snapshot()).toEqual(snapshot);
      expect(Md5.restore(snapshot, split).update(bytes.subarray(split)).digest()).toBe(
        createHash('md5').update(bytes).digest('hex')
      );
      expect(digest.update(bytes.subarray(split)).digest()).toBe(
        createHash('md5').update(bytes).digest('hex')
      );
    }
  );
  it.each([
    null,
    { version: 2 },
    { state: [1, 2, 3] },
    { state: [-1, 2, 3, 4] },
    { state: [4294967296, 2, 3, 4] },
    { state: [1.5, 2, 3, 4] },
    { bytes: 64 },
    { tail: [256] },
    { tail: [-1] },
    { tail: [] },
    { tail: [1, 2] }
  ])('rejects malformed or mismatched persisted state %j', patch => {
    const valid = new Md5().update(new Uint8Array([1])).snapshot();
    expect(() => Md5.restore(patch === null ? null : { ...valid, ...patch }, 1)).toThrow(
      'INVALID_MD5_SNAPSHOT'
    );
  });
});
