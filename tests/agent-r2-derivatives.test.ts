import { describe, expect, it, vi } from 'vitest';
import {
  parseFfprobeMedia,
  spaceDerivativeRequest,
  SpaceDerivativeBridge,
  variantsToMake,
  type SpaceDerivativeRequest,
  type SpaceDerivativeTools
} from '../apps/agent/src/team-bridge/r2-derivatives.js';

/**
 * 057 T046 (agent half) — the agent's backfill of an R2 file the browser could not picture
 * (T047): it reads the file through its ticket, asks ffprobe what it is (read as unknown), makes
 * only what the space still lacks with its ffmpeg, stages it under the lease and finishes with
 * the codec and frame rate; what nothing here can read is `unsupported`, a source that cannot be
 * read is `failed` (the next claim tries again, the server bounds the attempts).
 */

const TEAM = '05746200-0000-4000-8000-000000000001';
const OBJECT = '05746200-0000-4000-8000-000000000002';
const CONTENT = 'c'.repeat(64);
const LEASE = 'L'.repeat(43);
const BASE = 'https://api.test/functions/v1/space-storage';

function webp(width: number, height: number): Buffer {
  const out = Buffer.alloc(64);
  out.write('RIFF', 0);
  out.write('WEBPVP8X', 8);
  out[16] = 10;
  out.writeUIntLE(width - 1, 24, 3);
  out.writeUIntLE(height - 1, 27, 3);
  return out;
}

const probeVideo = {
  streams: [
    { codec_type: 'audio', codec_name: 'aac' },
    {
      codec_type: 'video',
      codec_name: 'HEVC',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30000/1001',
      side_data_list: [{ rotation: -90 }],
      duration: '12.5'
    }
  ],
  format: { duration: '12.6' }
};

function request(overrides: Partial<SpaceDerivativeRequest['job']> = {}): SpaceDerivativeRequest {
  return {
    job: {
      teamId: TEAM,
      objectId: OBJECT,
      contentId: CONTENT,
      contentType: 'video/quicktime',
      category: 'video',
      bytes: 100,
      made: [],
      needsMediaFacts: true,
      leaseToken: LEASE,
      source: {
        ticket: 't'.repeat(43),
        purpose: 'download_range',
        expiresAt: '2099-01-01T00:00:00Z',
        maxRangeBytes: 1,
        maxUses: 1
      } as never,
      ...overrides
    },
    transferUrl: `${BASE}/agent/source`,
    cloudBaseUrl: BASE
  };
}

function harness(probe: unknown = probeVideo) {
  const posts: Array<{ route: string; body: Record<string, unknown> }> = [];
  const puts: string[] = [];
  const cleanup = vi.fn(async () => undefined);
  const transfer = {
    downloadSource: vi.fn(async () => ({
      workspace: '/tmp/ws',
      file: '/tmp/ws/source.mov',
      sizeBytes: 100,
      sourceVersion: null,
      sourceChecksum: null,
      cleanup
    }))
  };
  const sizes: Record<string, [number, number]> = {};
  const tools: SpaceDerivativeTools = {
    probe: vi.fn(async () => probe),
    frame: vi.fn(async ({ maxEdge, target }) => {
      sizes[target] = [Math.round((maxEdge * 9) / 16), maxEdge];
      return true;
    }),
    sprite: vi.fn(async ({ target }) => {
      sizes[target] = [900, 640];
      return true;
    }),
    webp: vi.fn(async png => webp(...sizes[png]!))
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (init?.method === 'PUT') {
      puts.push(href.split('/').at(-1)!);
      return new Response(null, { status: 200 });
    }
    const route = href.slice(BASE.length);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push({ route, body });
    if (route === '/agent/derivatives/stage')
      return Response.json({
        derivatives: (body.derivatives as Array<{ variant: string; contentType: string }>).map(
          item => ({
            variant: item.variant,
            url: `https://acct.r2.cloudflarestorage.com/b/${item.variant}`,
            contentMd5: 'AAAAAAAAAAAAAAAAAAAAAA==',
            contentType: item.contentType,
            expiresAt: '2099-01-01T00:00:00.000Z'
          })
        )
      });
    return Response.json({
      state: body.outcome === 'ready' ? 'ready' : body.outcome,
      accepted: []
    });
  }) as unknown as typeof fetch;
  const bridge = new SpaceDerivativeBridge({ transfer, tools, fetchImpl });
  return { bridge, transfer, tools, posts, puts, cleanup };
}

describe('ffprobe is read as unknown', () => {
  it('takes the video stream, turned the way it plays, with codec and frame rate', () => {
    expect(parseFfprobeMedia(probeVideo)).toEqual({
      durationMs: 12_500,
      width: 1080,
      height: 1920,
      codec: 'hevc',
      fps: 29.97,
      hasPicture: true
    });
  });

  it('anything malformed gives nothing, never a guess', () => {
    for (const value of [
      null,
      'x',
      42,
      {},
      { streams: 'no' },
      { streams: [{ codec_type: 'audio' }] }
    ])
      expect(parseFfprobeMedia(value)).toMatchObject({ hasPicture: false, codec: null, fps: null });
    expect(
      parseFfprobeMedia({
        streams: [
          {
            codec_type: 'video',
            width: '1e9',
            height: -4,
            codec_name: 'a b;rm',
            avg_frame_rate: '1/0'
          }
        ]
      })
    ).toEqual({
      durationMs: null,
      width: null,
      height: null,
      codec: null,
      fps: null,
      hasPicture: false
    });
  });

  it('a still picture has no frame rate', () => {
    expect(
      parseFfprobeMedia({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            width: 10,
            height: 10,
            avg_frame_rate: '25/1'
          }
        ]
      }).fps
    ).toBeNull();
  });
});

describe('the backfill', () => {
  it('makes only the missing pictures, stages them under the lease, then finishes with the facts', async () => {
    const run = harness();
    const outcome = await run.bridge.run(request({ made: ['row'] }));
    expect(outcome.state).toBe('ready');
    expect(variantsToMake({ category: 'video', made: ['row'] })).toEqual([
      'tile',
      'full',
      'poster',
      'sprite'
    ]);
    const stage = run.posts.find(post => post.route === '/agent/derivatives/stage')!;
    expect(stage.body).toMatchObject({ teamId: TEAM, objectId: OBJECT, leaseToken: LEASE });
    expect(
      (stage.body.derivatives as Array<{ variant: string }>).map(item => item.variant)
    ).toEqual(['tile', 'full', 'poster', 'sprite']);
    expect(run.puts).toEqual(['tile', 'full', 'poster', 'sprite']);
    const finish = run.posts.find(post => post.route === '/agent/derivatives/finish')!;
    expect(finish.body).toMatchObject({
      outcome: 'ready',
      media: { codec: 'hevc', fps: 29.97, width: 1080, height: 1920, durationMs: 12_500 }
    });
    // Each declared size is the encoded picture's own.
    expect(
      (finish.body.derivatives as Array<{ variant: string; width: number }>).find(
        item => item.variant === 'sprite'
      )
    ).toMatchObject({ width: 900, height: 640 });
    expect(run.cleanup).toHaveBeenCalled();
  });

  it('pictures all there and only the facts missing: no picture is made', async () => {
    const run = harness();
    await run.bridge.run(request({ made: ['row', 'tile', 'full', 'poster', 'sprite'] }));
    expect(run.tools.frame).not.toHaveBeenCalled();
    expect(run.posts.map(post => post.route)).toEqual(['/agent/derivatives/finish']);
    expect(run.posts[0]!.body).toMatchObject({
      outcome: 'ready',
      derivatives: [],
      media: { codec: 'hevc' }
    });
  });

  it('what has no picture stream, or a PDF, is unsupported', async () => {
    const audio = harness({ streams: [{ codec_type: 'audio' }] });
    await audio.bridge.run(request());
    expect(audio.posts.at(-1)!.body).toMatchObject({
      outcome: 'unsupported',
      errorCode: 'UNSUPPORTED_FORMAT'
    });
    const pdf = harness();
    await pdf.bridge.run(
      request({ contentType: 'application/pdf', category: 'other', needsMediaFacts: false })
    );
    expect(pdf.transfer.downloadSource).not.toHaveBeenCalled();
    expect(pdf.posts.at(-1)!.body).toMatchObject({ outcome: 'unsupported' });
  });

  it('a source it cannot read is a failed attempt, tried again by the next claim', async () => {
    const run = harness();
    run.transfer.downloadSource.mockRejectedValueOnce(new Error('STORAGE_UNAVAILABLE'));
    await run.bridge.run(request());
    expect(run.posts.at(-1)!.body).toMatchObject({
      outcome: 'failed',
      errorCode: 'SOURCE_UNAVAILABLE'
    });
  });

  it('one job at a time', async () => {
    const run = harness();
    let release!: () => void;
    run.transfer.downloadSource.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () =>
            resolve({
              workspace: '/tmp/ws',
              file: '/tmp/ws/a',
              sizeBytes: 1,
              sourceVersion: null,
              sourceChecksum: null,
              cleanup: vi.fn(async () => undefined)
            });
        })
    );
    const first = run.bridge.run(request());
    await vi.waitFor(() => expect(run.bridge.busy()).toBe(true));
    await expect(run.bridge.run(request())).rejects.toThrow('WRONG_STATE');
    release();
    await first;
    expect(run.bridge.busy()).toBe(false);
  });

  it('reads only the request it knows', () => {
    const body = { ...request(), job: { ...request().job, bytes: '100' } };
    expect(spaceDerivativeRequest(body)?.job.objectId).toBe(OBJECT);
    expect(spaceDerivativeRequest({ ...body, job: { ...body.job, leaseToken: 'x' } })).toBeNull();
    expect(spaceDerivativeRequest({ ...body, job: { ...body.job, made: ['banner'] } })).toBeNull();
    expect(spaceDerivativeRequest({ ...body, cloudBaseUrl: 'file:///etc' })).toBeNull();
  });
});
