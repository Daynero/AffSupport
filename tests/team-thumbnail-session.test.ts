import { describe, expect, it } from 'vitest';
import { isThumbnailSession } from '../packages/shared/src/team/index';
import { parseThumbnailRequest } from '../supabase/functions/drive-transfer/handler';
import {
  classifyThumbnailResponse,
  thumbnailCachePath,
  validThumbnail
} from '../supabase/functions/_shared/thumbnails';

/**
 * Feature 011 (T039): the thumbnail session boundary. The request parser
 * decides which credential is being presented; the cache path is one formula
 * for the relay and the warm worker; the response classifier turns provider
 * answers into the one-line reasons the interface shows.
 */
const MATERIAL = '9d9c5b5f-2b6b-4c22-9a7e-3d2b1c0a0001';

describe('parseThumbnailRequest', () => {
  it('reads a session with its material, or a grant, and refuses anything half-formed', () => {
    const base = 'https://project.supabase.co/functions/v1/drive-transfer/thumbnail';
    expect(
      parseThumbnailRequest(new URL(`${base}?material=${MATERIAL}&session=${'s'.repeat(32)}`))
    ).toEqual({ mode: 'session', ticket: 's'.repeat(32), materialId: MATERIAL });
    expect(parseThumbnailRequest(new URL(`${base}?grant=${'g'.repeat(40)}`))).toEqual({
      mode: 'grant',
      ticket: 'g'.repeat(40)
    });
    expect(parseThumbnailRequest(new URL(`${base}?session=${'s'.repeat(32)}`))).toBeNull();
    expect(parseThumbnailRequest(new URL(`${base}?material=${MATERIAL}`))).toBeNull();
    expect(
      parseThumbnailRequest(new URL(`${base}?material=not-a-uuid&session=${'s'.repeat(32)}`))
    ).toBeNull();
    expect(parseThumbnailRequest(new URL(`${base}?grant=short`))).toBeNull();
    expect(parseThumbnailRequest(new URL(base))).toBeNull();
  });
});

describe('thumbnailCachePath', () => {
  it('is stable for one version and changes with the version, the material or the mime', async () => {
    const base = { teamId: 't', materialId: MATERIAL, sourceIdentity: 'v7', mimeType: 'image/png' };
    const a = await thumbnailCachePath(base);
    const b = await thumbnailCachePath({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}\.thumbnail$/u);
    expect(await thumbnailCachePath({ ...base, sourceIdentity: 'v8' })).not.toBe(a);
    expect(await thumbnailCachePath({ ...base, materialId: 'other' })).not.toBe(a);
    expect(await thumbnailCachePath({ ...base, mimeType: 'video/mp4' })).not.toBe(a);
    expect(await thumbnailCachePath({ ...base, sourceIdentity: null })).toBeNull();
  });
});

describe('classifyThumbnailResponse', () => {
  it('maps provider answers to the published reasons', () => {
    const ok = { status: 200, mimeType: 'image/jpeg', contentLength: 2048 };
    expect(classifyThumbnailResponse(ok)).toEqual({ state: 'ready' });
    expect(classifyThumbnailResponse({ ...ok, status: 403 })).toEqual({
      state: 'unavailable',
      reason: 'protected'
    });
    expect(classifyThumbnailResponse({ ...ok, status: 404 })).toEqual({
      state: 'unavailable',
      reason: 'provider_missing'
    });
    expect(classifyThumbnailResponse({ ...ok, mimeType: 'text/html' })).toEqual({
      state: 'unavailable',
      reason: 'unsupported'
    });
    expect(classifyThumbnailResponse({ ...ok, contentLength: 5 * 1024 * 1024 })).toEqual({
      state: 'unavailable',
      reason: 'too_large'
    });
    expect(classifyThumbnailResponse({ ...ok, contentLength: 0 })).toEqual({
      state: 'unavailable',
      reason: 'provider_missing'
    });
    expect(validThumbnail('image/webp', 100)).toBe(true);
    expect(validThumbnail('image/svg+xml', 100)).toBe(false);
  });
});

describe('isThumbnailSession', () => {
  it('requires a relay endpoint beside the token', () => {
    expect(
      isThumbnailSession({
        token: 't'.repeat(32),
        expiresAt: 'x',
        teamId: 'y',
        endpoint: 'https://p.supabase.co/functions/v1/drive-transfer/thumbnail'
      })
    ).toBe(true);
    expect(isThumbnailSession({ token: 't', expiresAt: 'x', teamId: 'y' })).toBe(false);
    expect(
      isThumbnailSession({ token: 't', expiresAt: 'x', teamId: 'y', endpoint: 'ftp://x' })
    ).toBe(false);
  });
});
