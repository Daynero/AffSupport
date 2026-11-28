import { describe, expect, it } from 'vitest';
import { SpaceR2, type SpaceR2Config } from '../supabase/functions/_shared/r2-space';
import { CatalogVideoSpaceReader } from '../supabase/functions/catalog-video-r2/space-reader';

/**
 * 057 T040: the catalog video of an R2 space is read from the space's own bucket, on the server,
 * through the same reader seam the Drive source uses (`CatalogVideoDriveReader`), so the copy
 * pipeline — ranged parts, metadata cleaning, full readback, promotion — is the one already
 * proven for Drive. No Drive client is involved.
 */

const TEAM = '57400000-0000-4000-8000-000000000001';
const CONTENT = 'a'.repeat(64);
const KEY = `t/${TEAM}/o/${CONTENT}`;
const config: SpaceR2Config = {
  environment: 'dev',
  accountId: 'b'.repeat(32),
  bucket: 'soty-spaces-dev',
  accessKeyId: 'not-a-key',
  secretAccessKey: 'not-a-secret'
};
const signer = {
  async sign(request: Request) {
    const headers = new Headers(request.headers);
    headers.set('authorization', 'AWS4-HMAC-SHA256 signed');
    return new Request(request, { headers });
  }
};

function bucket(etag: string) {
  const bytes = Uint8Array.from({ length: 100 }, (_, n) => n);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.host}${url.pathname}`);
    expect(request.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256/u);
    if (url.pathname !== `/soty-spaces-dev/${KEY}`) return new Response(null, { status: 404 });
    if (request.method === 'HEAD')
      return new Response(null, {
        status: 200,
        headers: { 'content-length': '100', etag, 'content-type': 'video/mp4' }
      });
    const [, s, e] = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get('range') ?? '')!;
    return new Response(bytes.slice(Number(s), Number(e) + 1), {
      status: 206,
      headers: {
        'content-range': `bytes ${s}-${e}/100`,
        'content-length': String(Number(e) - Number(s) + 1)
      }
    });
  };
  return { space: new SpaceR2(config, signer, fetcher), calls };
}

describe('CatalogVideoSpaceReader', () => {
  const md5 = 'c'.repeat(32);

  it('describes the space object as the Drive reader describes a file', async () => {
    const { space, calls } = bucket(`"${md5}"`);
    const reader = new CatalogVideoSpaceReader(space, TEAM);
    expect(await reader.getFile(CONTENT)).toEqual({
      id: CONTENT,
      checksum: md5,
      mimeType: 'video/mp4',
      size: 100,
      version: CONTENT,
      trashed: false
    });
    expect(calls).toEqual([
      `HEAD ${config.accountId}.r2.cloudflarestorage.com/soty-spaces-dev/${KEY}`
    ]);
  });

  it('a multipart object has no whole-file MD5, so the copy refuses it rather than guess', async () => {
    const { space } = bucket(`"${'d'.repeat(32)}-3"`);
    expect((await new CatalogVideoSpaceReader(space, TEAM).getFile(CONTENT)).checksum).toBeNull();
  });

  it('reads ranges from the space bucket, as Drive answers them', async () => {
    const { space } = bucket(`"${md5}"`);
    const response = await new CatalogVideoSpaceReader(space, TEAM).fetchFileRange({
      fileId: CONTENT,
      start: 10,
      end: 19
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(
      Array.from({ length: 10 }, (_, n) => n + 10)
    );
  });

  it('never reads outside its own space or by anything but a content id', async () => {
    const { space } = bucket(`"${md5}"`);
    const reader = new CatalogVideoSpaceReader(space, TEAM);
    await expect(reader.getFile('../other')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      reader.fetchFileRange({ fileId: 'drive-file-id', start: 0, end: 1 })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(() => new CatalogVideoSpaceReader(space, 'not-a-team')).toThrow();
    const missing = new CatalogVideoSpaceReader(space, '57400000-0000-4000-8000-000000000002');
    await expect(missing.getFile(CONTENT)).rejects.toMatchObject({
      code: 'VIDEO_R2_SOURCE_UNAVAILABLE'
    });
  });
});
