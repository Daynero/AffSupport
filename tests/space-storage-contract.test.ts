import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SPACE_STORAGE_CAPABILITY,
  SPACE_STORAGE_ERROR_CODES,
  SPACE_STORAGE_ERROR_STATUS,
  SPACE_STORAGE_LIMITS,
  declaresSpaceStorage,
  formatByteCount,
  normalizePartEtag,
  parseByteCount,
  parseSpaceAdmitResult,
  parseSpaceCreated,
  parseSpacePartUrls,
  parseSpaceQuotaDetails,
  parseSpaceReadGrantResult,
  parseSpaceStorageSummary,
  spaceContentId,
  spaceDerivativeKey,
  spaceObjectKey,
  spacePartBytes,
  spacePartCount,
  spacePartRange,
  spaceStagingKey,
  isSpaceKey
} from '../packages/shared/src/team/space-storage';
import {
  SpaceMd5,
  spaceMd5Base64,
  spaceMd5Hex,
  spaceMd5HexToBase64
} from '../packages/shared/src/team/space-storage-md5';
import {
  importSpaceReadGrantKey,
  peekSpaceReadGrantKeyVersion,
  signSpaceReadGrant,
  verifySpaceReadGrant,
  type SpaceReadGrantClaims
} from '../packages/shared/src/team/space-read-grant';
import { TEAM_ERROR_CODES } from '../packages/shared/src/team/transport';
import { SPACE_STORAGE_ERROR_CODES as TYPES_CODES } from '../packages/shared/src/types';
import { teamErrorMessage } from '../apps/web/src/team/errors';
import { en } from '../apps/web/src/locales/en';
import { uk } from '../apps/web/src/locales/uk';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

/**
 * 057 T004 — the shared contract of R2 spaces: closed parsing, exact bytes,
 * one content identity for every side, the read grant and the codes.
 */

const TEAM = '57000000-0000-4000-8000-000000000001';
const OTHER_TEAM = '57000000-0000-4000-8000-000000000002';
const USER = '57000000-0000-4000-8000-000000000003';
const UPLOAD = '57000000-0000-4000-8000-000000000004';
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const nodeMd5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

describe('byte counts', () => {
  it('keep exact values above 2^53 and accept only canonical decimal strings', () => {
    expect(parseByteCount('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(parseByteCount('9223372036854775807')).toBe(9_223_372_036_854_775_807n);
    expect(parseByteCount('9223372036854775808')).toBeNull();
    for (const bad of [1, '01', '-1', '1.5', '1e3', ' 1', '', null, undefined, 1n])
      expect(parseByteCount(bad), String(bad)).toBeNull();
    expect(formatByteCount(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(() => formatByteCount(-1n)).toThrow();
  });

  it('a storage summary sums its segments exactly and rejects an unknown category', () => {
    const big = '9007199254740993';
    const summary = {
      capacityBytes: '9223372036854775807',
      usedBytes: '9007199254740994',
      reservedBytes: '0',
      revision: 3,
      segments: [
        { category: 'materials', bytes: big, objects: 2, sharedBytes: '1' },
        { category: 'trash', bytes: '1', objects: 1, sharedBytes: '0' }
      ]
    };
    const parsed = parseSpaceStorageSummary(summary);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.segments[0]!.bytes).toBe(9_007_199_254_740_993n);
    expect(parseSpaceStorageSummary({ ...summary, usedBytes: '9007199254740995' }).ok).toBe(false);
    expect(
      parseSpaceStorageSummary({
        ...summary,
        segments: [
          ...summary.segments,
          { category: 'cache', bytes: '0', objects: 0, sharedBytes: '0' }
        ]
      }).ok
    ).toBe(false);
    expect(
      parseSpaceStorageSummary({
        ...summary,
        segments: [{ ...summary.segments[0], bytes: Number(big) }, summary.segments[1]]
      }).ok
    ).toBe(false);
    expect(
      parseSpaceStorageSummary({ ...summary, segments: [summary.segments[0], summary.segments[0]] })
        .ok
    ).toBe(false);
  });

  it('quota details carry need and free bytes as decimal strings', () => {
    expect(parseSpaceQuotaDetails({ needBytes: '10', freeBytes: '3' })).toEqual({
      ok: true,
      value: { needBytes: 10n, freeBytes: 3n }
    });
    expect(parseSpaceQuotaDetails({ needBytes: 10, freeBytes: '3' }).ok).toBe(false);
  });
});

describe('response parsing rejects what it does not know', () => {
  it('admit: exists or session, nothing else', () => {
    const session = {
      kind: 'session',
      uploadId: UPLOAD,
      partBytes: 16 * MIB,
      partCount: 3,
      derivativeSlots: ['row', 'tile'],
      expiresAt: '2026-11-28T10:00:00.000Z'
    };
    expect(parseSpaceAdmitResult(session).ok).toBe(true);
    expect(parseSpaceAdmitResult({ kind: 'exists', materialId: UPLOAD })).toEqual({
      ok: true,
      value: { kind: 'exists', materialId: UPLOAD }
    });
    expect(parseSpaceAdmitResult({ ...session, kind: 'queued' }).ok).toBe(false);
    expect(parseSpaceAdmitResult({ ...session, derivativeSlots: ['thumb'] }).ok).toBe(false);
    expect(parseSpaceAdmitResult({ ...session, derivativeSlots: ['row', 'row'] }).ok).toBe(false);
    expect(parseSpaceAdmitResult({ ...session, partBytes: 8 * MIB }).ok).toBe(false);
    expect(parseSpaceAdmitResult({ ...session, partCount: 10_001 }).ok).toBe(false);
    expect(parseSpaceAdmitResult({ kind: 'exists', materialId: 'drive-file-id' }).ok).toBe(false);
    expect(parseSpaceAdmitResult(null).ok).toBe(false);
  });

  it('part URLs are HTTPS, unique and bounded', () => {
    const part = {
      partNumber: 1,
      url: 'https://r2.example/x?sig=1',
      expiresAt: '2026-11-28T10:00:00Z'
    };
    expect(parseSpacePartUrls({ parts: [part] }).ok).toBe(true);
    expect(parseSpacePartUrls({ parts: [{ ...part, url: 'http://r2.example/x' }] }).ok).toBe(false);
    expect(parseSpacePartUrls({ parts: [part, part] }).ok).toBe(false);
    expect(parseSpacePartUrls({ parts: [] }).ok).toBe(false);
    expect(
      parseSpacePartUrls({
        parts: Array.from({ length: 101 }, (_, i) => ({ ...part, partNumber: i + 1 }))
      }).ok
    ).toBe(false);
  });

  it('read grant result names an origin, not a URL with a path', () => {
    const value = {
      grant: 'a'.repeat(123),
      expiresAt: '2026-11-28T10:00:00Z',
      filesOrigin: 'https://files-beta.soty.pp.ua'
    };
    expect(parseSpaceReadGrantResult(value).ok).toBe(true);
    expect(
      parseSpaceReadGrantResult({ ...value, filesOrigin: 'https://files-beta.soty.pp.ua/t/' }).ok
    ).toBe(false);
    expect(parseSpaceReadGrantResult({ ...value, grant: 'has space' }).ok).toBe(false);
  });

  it('a created space is R2 with a root folder', () => {
    expect(
      parseSpaceCreated({ teamId: TEAM, rootMaterialId: UPLOAD, storageBackend: 'r2' }).ok
    ).toBe(true);
    expect(
      parseSpaceCreated({ teamId: TEAM, rootMaterialId: UPLOAD, storageBackend: 'drive' }).ok
    ).toBe(false);
  });

  it('the capability header must name storage-r2/1 exactly', () => {
    expect(SPACE_STORAGE_CAPABILITY).toBe('storage-r2/1');
    expect(declaresSpaceStorage('catalog/2, storage-r2/1')).toBe(true);
    expect(declaresSpaceStorage('storage-r2/10')).toBe(false);
    expect(declaresSpaceStorage(null)).toBe(false);
  });
});

describe('content identity (research R3, part ETags)', () => {
  it('MD5 matches node:crypto across block boundaries and streaming splits', () => {
    for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const bytes = new Uint8Array(randomBytes(size));
      expect(spaceMd5Hex(bytes), `size ${size}`).toBe(nodeMd5(bytes));
      const streamed = new SpaceMd5();
      for (let at = 0; at < size; at += 37) streamed.update(bytes.subarray(at, at + 37));
      expect(Buffer.from(streamed.digest()).toString('hex')).toBe(nodeMd5(bytes));
    }
    expect(spaceMd5Hex(new TextEncoder().encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    const abc = new TextEncoder().encode('abc');
    expect(spaceMd5Base64(abc)).toBe(createHash('md5').update(abc).digest('base64'));
    expect(spaceMd5HexToBase64('900150983cd24fb0d6963f7d28e17f72')).toBe(spaceMd5Base64(abc));
    expect(spaceMd5HexToBase64('xyz')).toBeNull();
  });

  it('part size follows from the file size alone', () => {
    expect(spacePartBytes(0)).toBe(16 * MIB);
    expect(spacePartCount(0)).toBe(1);
    expect(spacePartCount(16 * MIB)).toBe(1);
    expect(spacePartCount(16 * MIB + 1)).toBe(2);
    expect(spacePartBytes(50 * GIB)).toBe(16 * MIB);
    expect(spacePartBytes(50 * GIB + 1)).toBe(64 * MIB);
    expect(spacePartCount(SPACE_STORAGE_LIMITS.maxObjectBytes)).toBe(1600);
    expect(spacePartCount(50 * GIB)).toBeLessThanOrEqual(SPACE_STORAGE_LIMITS.maxParts);
    expect(() => spacePartBytes(SPACE_STORAGE_LIMITS.maxObjectBytes + 1)).toThrow();
    expect(spacePartRange(16 * MIB + 5, 2)).toEqual({
      start: 16 * MIB,
      end: 16 * MIB + 4,
      bytes: 5
    });
    expect(() => spacePartRange(10, 2)).toThrow();
  });

  it('content_id = SHA-256 of scheme, part size, length and the ordered part MD5s', async () => {
    const total = 16 * MIB + 3;
    const file = new Uint8Array(randomBytes(total));
    const etags = [1, 2].map(n => {
      const { start, end } = spacePartRange(total, n);
      return nodeMd5(file.subarray(start, end + 1));
    });
    const expected = createHash('sha256')
      .update(['soty-space-content/1', String(16 * MIB), String(total), ...etags].join('\n'))
      .digest('hex');
    // The client side (own MD5) and the server side (R2's quoted ETags) agree.
    const client = await spaceContentId(
      total,
      [1, 2].map(n => {
        const { start, end } = spacePartRange(total, n);
        return spaceMd5Hex(file.subarray(start, end + 1));
      })
    );
    const server = await spaceContentId(
      total,
      etags.map(etag => `"${etag.toUpperCase()}"`)
    );
    expect(client).toEqual({ ok: true, contentId: expected });
    expect(server).toEqual(client);
    // Same bytes in a different order, or one byte more, is another identity.
    expect(await spaceContentId(total, [...etags].reverse())).not.toEqual(client);
    expect((await spaceContentId(total + 1, etags)).ok).toBe(true);
    expect(await spaceContentId(total + 1, etags)).not.toEqual(client);
  });

  it('refuses part lists that do not fit the size and object ETags', async () => {
    const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
    expect(await spaceContentId(0, [md5])).toMatchObject({ ok: true });
    expect(await spaceContentId(0, [])).toEqual({ ok: false, reason: 'part_count' });
    expect(await spaceContentId(16 * MIB + 1, [md5])).toEqual({ ok: false, reason: 'part_count' });
    expect(await spaceContentId(1, [`"${md5}-2"`])).toEqual({ ok: false, reason: 'etag' });
    expect(await spaceContentId(-1, [md5])).toEqual({ ok: false, reason: 'size' });
    expect(normalizePartEtag(`W/"${md5}"`)).toBeNull();
  });

  it('keys are the documented shapes and nothing else', () => {
    const id = 'a'.repeat(64);
    expect(spaceStagingKey(TEAM, UPLOAD)).toBe(`t/${TEAM}/u/${UPLOAD}`);
    expect(spaceObjectKey(TEAM, id)).toBe(`t/${TEAM}/o/${id}`);
    expect(spaceDerivativeKey(TEAM, id, 1, 'tile')).toBe(`t/${TEAM}/d/${id}/1/tile`);
    for (const key of [
      spaceStagingKey(TEAM, UPLOAD),
      spaceObjectKey(TEAM, id),
      spaceDerivativeKey(TEAM, id, 1, 'poster')
    ])
      expect(isSpaceKey(key)).toBe(true);
    expect(isSpaceKey(`t/${TEAM}/o/${id}/../x`)).toBe(false);
    expect(() => spaceObjectKey('../', id)).toThrow();
    expect(() => spaceDerivativeKey(TEAM, id, 1, 'huge' as 'row')).toThrow();
  });
});

describe('read grant', () => {
  const now = 1_800_000_000;
  const claims: SpaceReadGrantClaims = {
    environment: 'beta',
    keyVersion: 2,
    teamId: TEAM,
    userId: USER,
    accessEpoch: 9_007_199_254_740_993n,
    issuedAt: now,
    expiresAt: now + 600
  };
  const keyFor = async (seed: number) => importSpaceReadGrantKey(new Uint8Array(32).fill(seed));

  it('round-trips the claims and is verified in the contract order', async () => {
    const key = await keyFor(7);
    const keys = new Map([[2, key]]);
    const grant = await signSpaceReadGrant(claims, key);
    expect(grant).toMatch(/^[A-Za-z0-9_-]{123}$/u);
    expect(peekSpaceReadGrantKeyVersion(grant)).toBe(2);
    const verdict = await verifySpaceReadGrant(grant, {
      environment: 'beta',
      keys,
      teamId: TEAM,
      nowSeconds: now + 1,
      currentEpoch: claims.accessEpoch
    });
    expect(verdict).toEqual({ ok: true, claims });

    const base = { environment: 'beta' as const, keys, teamId: TEAM, nowSeconds: now + 1 };
    expect(await verifySpaceReadGrant(grant, { ...base, nowSeconds: now + 600 })).toEqual({
      ok: false,
      reason: 'expired'
    });
    expect(await verifySpaceReadGrant(grant, { ...base, teamId: OTHER_TEAM })).toEqual({
      ok: false,
      reason: 'team'
    });
    expect(
      await verifySpaceReadGrant(grant, { ...base, currentEpoch: claims.accessEpoch + 1n })
    ).toEqual({ ok: false, reason: 'epoch' });
    expect(await verifySpaceReadGrant(grant, { ...base, environment: 'production' })).toEqual({
      ok: false,
      reason: 'malformed'
    });
    expect(
      await verifySpaceReadGrant(grant, { ...base, keys: new Map([[2, await keyFor(8)]]) })
    ).toEqual({ ok: false, reason: 'signature' });
    expect(await verifySpaceReadGrant(grant, { ...base, keys: new Map([[1, key]]) })).toEqual({
      ok: false,
      reason: 'signature'
    });
    // A signature check comes before the team check: a forged team is a bad signature.
    const forged = `${grant.slice(0, 10)}${grant[10] === 'A' ? 'B' : 'A'}${grant.slice(11)}`;
    expect((await verifySpaceReadGrant(forged, base)).ok).toBe(false);
    expect(await verifySpaceReadGrant('x', base)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('never signs a grant that lives longer than ten minutes or names no space', async () => {
    const key = await keyFor(7);
    await expect(signSpaceReadGrant({ ...claims, expiresAt: now + 601 }, key)).rejects.toThrow();
    await expect(signSpaceReadGrant({ ...claims, teamId: 'drive' }, key)).rejects.toThrow();
    await expect(importSpaceReadGrantKey(new Uint8Array(16))).rejects.toThrow();
  });
});

describe('codes', () => {
  it('are team codes, exported from types, translated in both locales and have their HTTP status', () => {
    expect([...TYPES_CODES]).toEqual([...SPACE_STORAGE_ERROR_CODES]);
    const t = (key: keyof typeof en) => en[key];
    for (const code of SPACE_STORAGE_ERROR_CODES) {
      expect(TEAM_ERROR_CODES as readonly string[]).toContain(code);
      const sentence = teamErrorMessage(code, t);
      expect(sentence, code).not.toBe(en.teamErrorUnknown);
      const key = (Object.keys(en) as (keyof typeof en)[]).find(name => en[name] === sentence)!;
      expect(uk[key], code).toBeTruthy();
      expect(uk[key]).not.toBe(en[key]);
      expect(new TeamFunctionError(code).status, code).toBe(SPACE_STORAGE_ERROR_STATUS[code]);
    }
    expect(SPACE_STORAGE_ERROR_STATUS.R2_PILOT_REQUIRED).toBe(403);
    expect(SPACE_STORAGE_ERROR_STATUS.STORAGE_OBJECT_TOO_LARGE).toBe(413);
    expect(SPACE_STORAGE_ERROR_STATUS.STORAGE_QUOTA_EXCEEDED).toBe(409);
  });
});
