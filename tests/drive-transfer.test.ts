import { describe, expect, it, vi } from 'vitest';
import {
  buildDownloadGrantResult,
  MAX_PREVIEW_RANGE_BYTES,
  authorizePreviewRange,
  buildPreviewResult,
  boundedResponseBody,
  forwardedRangeHeaders,
  ensureLandingArtifactFolder,
  landingArtifactGrantTool,
  parseLandingArtifactGrantTool,
  parseBoundedRange,
  publicEndpointUrl,
  summarizePreviewMeasurements,
  validateUpstreamRangeResponse,
  type PreviewMaterialRecord
} from '../supabase/functions/drive-transfer/handler.js';
import {
  parseResumableOffset,
  resumableUpload,
  validateRelayChunk
} from '../apps/web/src/team/drive/resumableUpload.js';

const MiB = 1024 * 1024;
const TEAM_ID = '41000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '41000000-0000-4000-8000-000000000002';
const ACTOR_ID = '41000000-0000-4000-8000-000000000003';

function material(overrides: Partial<PreviewMaterialRecord> = {}): PreviewMaterialRecord {
  return {
    teamId: TEAM_ID,
    materialId: MATERIAL_ID,
    driveFileId: 'drive-file-1',
    resourceKey: null,
    name: 'launch.mp4',
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    sizeBytes: 64 * MiB,
    driveVersion: '17',
    checksum: 'checksum-17',
    previewState: 'ready',
    previewErrorCode: null,
    transcriptText: null,
    transcriptIngestState: 'not_applicable',
    transcriptTruncated: false,
    transcriptIndexedBytes: 0,
    transcriptSourceVersion: null,
    canDownload: true,
    canEdit: true,
    ...overrides
  };
}

describe('team preview transfer contract', () => {
  it('uses the public HTTPS Functions endpoint while preserving local loopback', () => {
    expect(
      publicEndpointUrl(
        new URL('http://project.supabase.co/functions/v1/drive-transfer/range?grant=opaque')
      ).toString()
    ).toBe('https://project.supabase.co/functions/v1/drive-transfer/range?grant=opaque');
    expect(
      publicEndpointUrl(
        new URL('http://project.supabase.co/drive-transfer/range?grant=opaque')
      ).toString()
    ).toBe('https://project.supabase.co/functions/v1/drive-transfer/range?grant=opaque');
    expect(
      publicEndpointUrl(
        new URL('http://127.0.0.1:54321/functions/v1/drive-transfer/range')
      ).toString()
    ).toBe('http://127.0.0.1:54321/functions/v1/drive-transfer/range');
  });

  it('repairs the address the local stack reports for itself', () => {
    // What the edge runtime actually sees inside the container: its own port, and a path the
    // gateway has already stripped the prefix from. Handed out unrepaired, the paired app
    // refused it in three milliseconds without ever reaching the network, and no team
    // download could be tested anywhere but production.
    expect(
      publicEndpointUrl(new URL('http://127.0.0.1:8081/drive-transfer/range'), {
        host: '127.0.0.1',
        port: '54321'
      }).toString()
    ).toBe('http://127.0.0.1:54321/functions/v1/drive-transfer/range');
    // Loopback stays http — it is the one place that is not mixed content.
    expect(
      publicEndpointUrl(new URL('http://localhost:8081/drive-ops'), {
        host: 'localhost',
        port: '54321'
      }).toString()
    ).toBe('http://localhost:54321/functions/v1/drive-ops');
    // Nothing forwarded: the path is still repaired, the address is left alone.
    expect(publicEndpointUrl(new URL('http://127.0.0.1:54321/drive-transfer/range')).toString()).toBe(
      'http://127.0.0.1:54321/functions/v1/drive-transfer/range'
    );
  });

  it('will not be told to hand its grant to somebody else', () => {
    // The headers are the gateway's, but a client can send them too, and this URL travels
    // with a ticket. A loopback request may only be repaired to loopback.
    expect(
      publicEndpointUrl(new URL('http://127.0.0.1:8081/drive-transfer/range'), {
        host: 'evil.example',
        port: '443'
      }).toString()
      // Nothing is taken: not the host, and not the port that came with it.
    ).toBe('http://127.0.0.1:8081/functions/v1/drive-transfer/range');
    // And a public request takes nothing from them at all.
    expect(
      publicEndpointUrl(new URL('http://project.supabase.co/drive-transfer/range'), {
        host: 'evil.example',
        port: '8443'
      }).toString()
    ).toBe('https://project.supabase.co/functions/v1/drive-transfer/range');
  });

  it('binds opaque landing artifact grants to one render and segment', () => {
    const renderId = '41000000-0000-4000-8000-000000000010';
    const operationId = '41000000-0000-4000-8000-000000000011';
    const upload = landingArtifactGrantTool({ mode: 'upload', renderId, operationId });
    const view = landingArtifactGrantTool({ mode: 'view', renderId, segment: 3 });
    expect(parseLandingArtifactGrantTool(upload)).toEqual({
      mode: 'upload',
      renderId,
      operationId
    });
    expect(parseLandingArtifactGrantTool(view)).toEqual({ mode: 'view', renderId, segment: 3 });
    expect(parseLandingArtifactGrantTool(`${view}:../../secret`)).toBeNull();
    expect(parseLandingArtifactGrantTool(`landing-render:${renderId}:99`)).toBeNull();
    expect(JSON.stringify({ upload, view })).not.toMatch(/drive|vault|token|path/i);
  });

  it('creates the hidden landing cache hierarchy once and reuses it', async () => {
    const children = new Map<
      string,
      Array<{ id: string; name: string; mimeType: string; trashed: boolean }>
    >();
    const createFolder = vi.fn(async ({ name, parentId }: { name: string; parentId: string }) => {
      const value = {
        id: `${parentId}/${name}`,
        name,
        mimeType: 'application/vnd.google-apps.folder',
        trashed: false
      };
      children.set(parentId, [...(children.get(parentId) ?? []), value]);
      return value;
    });
    const client = {
      listChildren: vi.fn(async ({ parentId }: { parentId: string }) => ({
        files: children.get(parentId) ?? []
      })),
      createFolder
    };
    const input = {
      rootFolderId: 'root',
      materialId: MATERIAL_ID,
      sourceVersion: '7',
      fingerprint: 'a'.repeat(64),
      preset: 'default'
    };
    const first = await ensureLandingArtifactFolder(client, input);
    const second = await ensureLandingArtifactFolder(client, input);
    expect(first).toBe(second);
    expect(createFolder).toHaveBeenCalledTimes(5);
    expect(first).toContain('.soty/landing-previews');
    expect(first).toContain(`/7-${'a'.repeat(64)}/default`);
  });

  it('issues short-lived scoped media and agent grants without provider credentials', async () => {
    const issueGrant = vi.fn().mockResolvedValue({
      ticket: 'opaque-preview-ticket-with-enough-entropy',
      purpose: 'preview_range' as const,
      expiresAt: '2026-08-01T12:05:00.000Z',
      maxRangeBytes: MAX_PREVIEW_RANGE_BYTES,
      maxUses: 512
    });

    const media = await buildPreviewResult(material(), 'media', issueGrant, {
      rangeEndpoint: 'https://project.supabase.co/functions/v1/drive-transfer/range'
    });
    expect(media).toEqual({
      kind: 'media',
      rangeUrl:
        'https://project.supabase.co/functions/v1/drive-transfer/range?grant=opaque-preview-ticket-with-enough-entropy',
      mimeType: 'video/mp4',
      expiresAt: '2026-08-01T12:05:00.000Z'
    });

    const archive = await buildPreviewResult(
      material({ name: 'bundle.zip', category: 'archive', mimeType: 'application/zip' }),
      'archive',
      issueGrant,
      {
        rangeEndpoint: 'https://project.supabase.co/functions/v1/drive-transfer/range',
        operationId: () => '41000000-0000-4000-8000-000000000099'
      }
    );
    expect(archive).toMatchObject({
      kind: 'agent',
      operationId: '41000000-0000-4000-8000-000000000099',
      previewKind: 'archive',
      transferGrant: { purpose: 'preview_range', maxRangeBytes: 32 * MiB }
    });
    expect(JSON.stringify(archive)).not.toMatch(/access_token|refresh_token|credential/i);
    expect(issueGrant).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: 'full TXT',
      row: material({
        name: 'notes.txt',
        category: 'transcript',
        mimeType: 'text/plain',
        fileExtension: 'txt',
        sizeBytes: 12,
        transcriptText: 'safe text',
        transcriptIngestState: 'full',
        transcriptIndexedBytes: 9,
        transcriptSourceVersion: '17'
      }),
      expected: { text: 'safe text', ingestState: 'full', allowedActions: ['download', 'edit'] }
    },
    {
      label: 'truncated TXT',
      row: material({
        name: 'large.txt',
        category: 'transcript',
        mimeType: 'text/plain',
        fileExtension: 'txt',
        sizeBytes: 2 * MiB,
        transcriptText: 'complete UTF-8 boundary',
        transcriptIngestState: 'truncated',
        transcriptTruncated: true,
        transcriptIndexedBytes: MiB,
        transcriptSourceVersion: '17'
      }),
      expected: {
        text: 'complete UTF-8 boundary',
        ingestState: 'truncated',
        allowedActions: ['download']
      }
    },
    {
      label: 'invalid SRT',
      row: material({
        name: 'captions.srt',
        category: 'transcript',
        mimeType: 'application/x-subrip',
        fileExtension: 'srt',
        transcriptText: null,
        transcriptIngestState: 'invalid_encoding',
        transcriptIndexedBytes: 0
      }),
      expected: { text: null, ingestState: 'invalid_encoding', allowedActions: ['download'] }
    },
    {
      label: 'unavailable VTT without download permission',
      row: material({
        name: 'captions.vtt',
        category: 'transcript',
        mimeType: 'text/vtt',
        fileExtension: 'vtt',
        transcriptText: null,
        transcriptIngestState: 'unavailable',
        transcriptIndexedBytes: 0,
        canDownload: false
      }),
      expected: { text: null, ingestState: 'unavailable', allowedActions: [] }
    }
  ])('returns explicit $label fields and only valid actions', async ({ row, expected }) => {
    const result = await buildPreviewResult(row, 'transcript', vi.fn());
    expect(result).toMatchObject({ kind: 'transcript', ...expected });
    expect(result).toMatchObject({
      truncated: row.transcriptTruncated,
      indexedBytes: row.transcriptIndexedBytes,
      sourceVersion: row.transcriptSourceVersion
    });
  });

  it.each([
    ['unsupported', { category: 'other', previewState: 'unavailable' }],
    ['corrupt', { category: 'archive', previewState: 'failed', previewErrorCode: 'CORRUPT' }],
    ['protected', { category: 'archive', previewState: 'failed', previewErrorCode: 'PROTECTED' }],
    ['too_large', { category: 'archive', previewState: 'failed', previewErrorCode: 'TOO_LARGE' }],
    ['agent_required', { category: 'archive', previewState: 'ready' }]
  ] as const)('maps %s preview state to a typed unavailable result', async (reason, patch) => {
    const result = await buildPreviewResult(
      material({ ...patch, canDownload: true } as Partial<PreviewMaterialRecord>),
      patch.category === 'other' ? 'media' : 'archive',
      patch.previewState === 'ready'
        ? async () => {
            throw new Error('AGENT_REQUIRED');
          }
        : vi.fn()
    );
    expect(result).toEqual({ kind: 'unavailable', reason, allowedActions: ['download'] });
  });

  it('accepts exactly one bounded byte range and forwards only safe inline headers', () => {
    expect(parseBoundedRange(null, 64 * MiB)).toEqual({ start: 0, end: 32 * MiB - 1 });
    expect(parseBoundedRange('bytes=1048576-', 64 * MiB)).toEqual({
      start: MiB,
      end: 33 * MiB - 1
    });
    expect(parseBoundedRange('bytes=-1024', 64 * MiB)).toEqual({
      start: 64 * MiB - 1024,
      end: 64 * MiB - 1
    });
    expect(() => parseBoundedRange(`bytes=0-${32 * MiB}`, 64 * MiB)).toThrow('TOO_LARGE');
    expect(() => parseBoundedRange('bytes=0-1,4-5', 64 * MiB)).toThrow('INVALID_INPUT');

    const upstream = new Headers({
      'content-length': '1024',
      'content-range': 'bytes 0-1023/2048',
      'accept-ranges': 'bytes',
      etag: 'provider-secret-etag',
      location: 'https://www.googleapis.com/private',
      'set-cookie': 'secret=value'
    });
    // A download carries the file's own name — the browser ignores an anchor's
    // `download` across origins, so without it the file was saved as "range".
    expect(
      forwardedRangeHeaders(upstream, 'video/mp4', 'attachment', 'Ролик — фінал.mp4').get(
        'content-disposition'
      )
    ).toBe(
      `attachment; filename="_____ _ _____.mp4"; filename*=UTF-8''${encodeURIComponent('Ролик — фінал.mp4')}`
    );
    expect(Object.fromEntries(forwardedRangeHeaders(upstream, 'video/mp4', 'inline'))).toEqual({
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-disposition': 'inline',
      'content-length': '1024',
      'content-range': 'bytes 0-1023/2048',
      'content-type': 'video/mp4',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
    expect(validateUpstreamRangeResponse(206, upstream, { start: 0, end: 1023 }, 2048)).toBe(1024);
    expect(() =>
      validateUpstreamRangeResponse(
        200,
        new Headers({ 'content-length': '1024' }),
        { start: 0, end: 1023 },
        2048
      )
    ).toThrow('INVALID_RESPONSE');
  });

  it('terminates a provider body that lies about the authorized response length', async () => {
    const overflow = boundedResponseBody(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        }
      }),
      8
    );
    await expect(new Response(overflow).arrayBuffer()).rejects.toThrow('INVALID_RESPONSE');
  });

  it('rechecks grant permission, live root ancestry, and Drive download capability per range', async () => {
    const consumeGrant = vi
      .fn()
      .mockResolvedValueOnce({
        teamId: TEAM_ID,
        actorId: ACTOR_ID,
        materialId: MATERIAL_ID,
        maxRangeBytes: MAX_PREVIEW_RANGE_BYTES
      })
      .mockResolvedValueOnce(null);
    const loadMaterial = vi.fn().mockResolvedValue(material());
    const proveLiveAccess = vi.fn().mockResolvedValue({
      fileId: 'drive-file-1',
      resourceKey: null,
      sizeBytes: 64 * MiB,
      mimeType: 'video/mp4',
      canDownload: true
    });

    await expect(
      authorizePreviewRange(
        { ticket: 'opaque-ticket', rangeHeader: 'bytes=0-1023' },
        { consumeGrant, loadMaterial, proveLiveAccess }
      )
    ).resolves.toMatchObject({ range: { start: 0, end: 1023 } });
    await expect(
      authorizePreviewRange(
        { ticket: 'opaque-ticket', rangeHeader: 'bytes=0-1023' },
        { consumeGrant, loadMaterial, proveLiveAccess }
      )
    ).rejects.toThrow('PERMISSION_DENIED');
    expect(loadMaterial).toHaveBeenCalledTimes(1);
    expect(proveLiveAccess).toHaveBeenCalledTimes(1);
  });

  it('summarizes a 100-attempt category/cache/network matrix without transcript propagation', () => {
    const categories = ['video', 'image', 'transcript', 'archive', 'landing'] as const;
    const attempts = categories.flatMap(category =>
      Array.from({ length: 20 }, (_, index) => ({
        category,
        cache: index % 2 === 0 ? ('cold' as const) : ('warm' as const),
        network: '50/10 Mbps · 50 ms RTT · 0% loss',
        elapsedMs: index === 19 ? 2_500 : 1_250,
        outcome: index === 19 ? ('typed_error' as const) : ('useful' as const),
        falseReady: false
      }))
    );
    const summary = summarizePreviewMeasurements(attempts);
    expect(summary).toEqual({
      attempts: 100,
      usefulWithinTarget: 95,
      typedRemainder: 5,
      falseReady: 0,
      meetsSc006: true
    });
    expect(JSON.stringify(summary)).not.toContain('transcript');
    expect(JSON.stringify(attempts[40])).not.toMatch(/text|fileName|materialId|teamId/i);
  });
});

describe('resumable upload and full-download transfer contract', () => {
  it('starts at an aligned boundary, honors 308 Range, resumes, and finalizes once', async () => {
    const payload = new Blob([new Uint8Array(768 * 1024)]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { range: 'bytes=0-262143' } })
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { range: 'bytes=0-524287' } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'drive-result-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const finalize = vi.fn().mockResolvedValue({ operationId: 'operation-1', state: 'succeeded' });

    const result = await resumableUpload({
      source: payload,
      sessionUri: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque',
      operationId: 'operation-1',
      idempotencyKey: 'upload-finalize-0001',
      chunkBytes: 256 * 1024,
      fetchImpl,
      finalize
    });

    expect(result).toEqual({ operationId: 'operation-1', state: 'succeeded' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.map(([, init]) => (init?.headers as Headers).get('content-range'))
    ).toEqual([
      'bytes 0-262143/786432',
      'bytes 262144-524287/786432',
      'bytes 524288-786431/786432'
    ]);
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith({
      operationId: 'operation-1',
      driveFileId: 'drive-result-1',
      idempotencyKey: 'upload-finalize-0001'
    });
  });

  it('queries provider state after an interrupted chunk and resumes from the received Range', async () => {
    const source = new Blob([new Uint8Array(512 * 1024)]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network interrupted'))
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { range: 'bytes=0-262143' } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'drive-resumed' }), { status: 200 })
      );

    await resumableUpload({
      source,
      sessionUri: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque',
      operationId: 'operation-resume',
      idempotencyKey: 'upload-resume-0001',
      chunkBytes: 256 * 1024,
      fetchImpl,
      finalize: vi.fn().mockResolvedValue({ state: 'succeeded' })
    });

    const queryHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Headers;
    expect(queryHeaders.get('content-range')).toBe('bytes */524288');
    expect(queryHeaders.get('content-length')).toBe('0');
    expect((fetchImpl.mock.calls[2]?.[1]?.headers as Headers).get('content-range')).toBe(
      'bytes 262144-524287/524288'
    );
  });

  it('rejects misaligned intermediate offsets and bounds relay chunks to one aligned segment', () => {
    expect(parseResumableOffset(308, new Headers({ range: 'bytes=0-262143' }), 1024 * 1024)).toBe(
      262144
    );
    expect(() =>
      parseResumableOffset(308, new Headers({ range: 'bytes=0-100' }), 1024 * 1024)
    ).toThrow('INVALID_RESPONSE');
    expect(
      validateRelayChunk({
        offset: 256 * 1024,
        contentLength: 256 * 1024,
        totalBytes: 1024 * 1024
      })
    ).toEqual({ start: 256 * 1024, end: 512 * 1024 - 1 });
    expect(() =>
      validateRelayChunk({ offset: 1, contentLength: 256 * 1024, totalBytes: 1024 * 1024 })
    ).toThrow('INVALID_INPUT');
    expect(() =>
      validateRelayChunk({ offset: 0, contentLength: 32 * MiB + 1, totalBytes: 64 * MiB })
    ).toThrow('TOO_LARGE');
  });

  it('uses browser attachment only through 100 MiB and routes larger downloads to the agent', async () => {
    const issueGrant = vi.fn().mockResolvedValue({
      ticket: 'opaque-download-ticket-with-enough-entropy',
      purpose: 'download_range',
      expiresAt: '2026-08-01T12:05:00.000Z',
      maxRangeBytes: 32 * MiB,
      maxUses: 8
    });
    await expect(
      buildDownloadGrantResult(
        material({ sizeBytes: 100 * MiB }),
        { consumer: 'browser', rangeEndpoint: 'https://edge.test/range' },
        issueGrant
      )
    ).resolves.toMatchObject({ kind: 'browser', disposition: 'attachment' });
    await expect(
      buildDownloadGrantResult(
        material({ sizeBytes: 100 * MiB + 1 }),
        { consumer: 'browser', rangeEndpoint: 'https://edge.test/range' },
        issueGrant
      )
    ).rejects.toThrow('AGENT_REQUIRED');
    await expect(
      buildDownloadGrantResult(
        material({ sizeBytes: 5 * 1024 * MiB }),
        { consumer: 'agent', rangeEndpoint: 'https://edge.test/range' },
        issueGrant
      )
    ).resolves.toMatchObject({ kind: 'agent', grant: { purpose: 'download_range' } });
  });
});
