import { describe, expect, it, vi } from 'vitest';
import { spaceContentId } from '../packages/shared/src/team/space-storage';
import { spaceMd5Hex } from '../packages/shared/src/team/space-storage-md5';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import type { SpaceListedPart } from '../supabase/functions/_shared/r2-space';
import {
  acknowledgeProcessQuiesced,
  agentSource,
  finalizeProcessOutput,
  parseProcessStartCommand,
  signProcessOutputParts,
  startProcessOutput,
  startSpaceProcess,
  type ProcessDeps
} from '../supabase/functions/space-storage/process';
import type { SpaceUploadBucket } from '../supabase/functions/space-storage/uploads';

/**
 * 057 T034 — a tool run in an R2 space through `space-storage` (T035): `/process/start`,
 * `/agent/source`, `/process/output/{start,parts,finalize,quiesced}`, against a fake database
 * and a fake bucket. The database half (source facts, the processed_from link, the `process`
 * category, idempotent finalize) is supabase/tests/database/space-storage-process.test.sql.
 */

const ACTOR = '05734000-0000-4000-8000-000000000002';
const TEAM = '05734000-0000-4000-8000-000000000011';
const ROOT = '05734000-0000-4000-8000-000000000101';
const SOURCE = '05734000-0000-4000-8000-0000000000a1';
const OPERATION = '05734000-0000-4000-8000-0000000000c1';
const UPLOAD = '05734000-0000-4000-8000-0000000000d1';
const OUTPUT = '05734000-0000-4000-8000-0000000000e1';
const SOURCE_CONTENT = 'a'.repeat(64);
const BYTES = new TextEncoder().encode('compressed');
const PART_MD5 = spaceMd5Hex(BYTES);
const TICKET = 't'.repeat(43);

async function outputContentId() {
  const result = await spaceContentId(BYTES.length, [PART_MD5]);
  if (!result.ok) throw new Error('fixture');
  return result.contentId;
}

interface Upload {
  state: 'open' | 'completing' | 'committed' | 'aborted';
  r2UploadId: string | null;
  contentId: string;
}

function fakeWorld(options: { tool?: string; childNames?: string[]; category?: string } = {}) {
  const state = {
    operation: {
      state: 'running' as 'running' | 'succeeded' | 'failed',
      resultMaterialId: null as string | null
    },
    upload: null as Upload | null,
    consumed: [] as string[],
    grants: [] as Record<string, unknown>[],
    transitions: [] as Record<string, unknown>[],
    finalizes: 0,
    links: [] as Record<string, unknown>[],
    transcripts: [] as Record<string, unknown>[],
    preps: [] as Record<string, unknown>[],
    grantValid: true,
    admitted: [] as Record<string, unknown>[]
  };
  const session = (u: Upload) => ({
    kind: 'session',
    uploadId: UPLOAD,
    partBytes: 16 * 1024 * 1024,
    partCount: 1,
    derivativeSlots: [],
    expiresAt: '2026-11-29T00:00:00.000Z',
    state: u.state,
    r2UploadId: u.r2UploadId,
    objectKey: `t/${TEAM}/o/${u.contentId}`,
    declaredContentId: u.contentId,
    declaredBytes: String(BYTES.length),
    objectEtag: null,
    resultMaterialId: null,
    name: 'Clip-compressed.mp4',
    contentType: 'video/mp4',
    teamId: TEAM
  });
  const snapshot = (id: string, contentId: string, bytes: number, name: string) => ({
    id,
    teamId: TEAM,
    parentMaterialId: ROOT,
    name,
    kind: 'file',
    lifecycle: 'active',
    materialRevision: '0',
    contentId,
    sizeBytes: String(bytes),
    mimeType: 'video/mp4'
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case 'service_space_storage_context':
        return {
          member: true,
          storageBackend: 'r2',
          storagePilot: true,
          actorPilot: true,
          workspaceAllowed: true,
          archived: false,
          allowed: true,
          accessEpoch: '7',
          contentRevision: '0',
          rootMaterialId: ROOT
        };
      case 'service_space_process_source':
        return {
          materialId: SOURCE,
          name: 'Clip.mp4',
          category: options.category ?? 'video',
          mimeType: 'video/mp4',
          sizeBytes: '400',
          contentId: SOURCE_CONTENT,
          destinationFolderId: ROOT,
          childNames: options.childNames ?? ['Clip.mp4']
        };
      case 'service_start_team_operation':
        return [{ operation_id: OPERATION, state: 'pending', reused: false }];
      case 'service_set_team_operation_intent':
        return true;
      case 'service_transition_team_operation':
        state.transitions.push(args);
        if (args.p_state === 'failed') state.operation.state = 'failed';
        return null;
      case 'issue_team_transfer_grant':
        state.grants.push(args);
        return null;
      case 'consume_team_transfer_grant':
        state.consumed.push(String(args.p_purpose));
        if (!state.grantValid) return [];
        return [
          {
            grant_id: '05734000-0000-4000-8000-0000000000f1',
            operation_id: OPERATION,
            team_id: TEAM,
            actor_id: ACTOR,
            material_id: args.p_purpose === 'process_input' ? SOURCE : null,
            destination_folder_id: ROOT,
            tool_id: options.tool ?? 'compressor',
            max_range_bytes: 32 * 1024 * 1024
          }
        ];
      case 'service_get_team_operation':
        return [
          {
            operation_id: OPERATION,
            team_id: TEAM,
            actor_id: ACTOR,
            kind: 'process',
            state: state.operation.state,
            source_material_id: SOURCE,
            destination_folder_id: ROOT,
            result_material_id: state.operation.resultMaterialId,
            expected_name: 'Clip-compressed.mp4',
            mime_type: 'video/mp4',
            expected_size: null,
            replace_material_id: null,
            version_of_material_id: null,
            relation: 'processed_from',
            tool_id: options.tool ?? 'compressor',
            tool_contract_version: 3
          }
        ];
      case 'service_read_space_materials':
        if ((args.p_ids as string[]).includes(OUTPUT) && state.upload)
          return [
            snapshot(
              OUTPUT,
              state.upload.contentId,
              BYTES.length,
              options.tool === 'transcription' ? 'Clip.txt' : 'Clip-compressed.mp4'
            )
          ];
        return [snapshot(SOURCE, SOURCE_CONTENT, 400, 'Clip.mp4')];
      case 'service_commit_space_transcript':
        state.transcripts.push(args);
        return true;
      case 'service_record_material_restitch_prep':
        state.preps.push(args);
        return true;
      case 'service_admit_space_upload': {
        state.admitted.push(args.p_input as Record<string, unknown>);
        const input = args.p_input as Record<string, unknown>;
        state.upload ??= {
          state: 'open',
          r2UploadId: null,
          contentId: String(input.contentId)
        };
        return session(state.upload);
      }
      case 'service_attach_space_upload':
        state.upload!.r2UploadId ??= String(args.p_r2_upload_id);
        return session(state.upload!);
      case 'service_space_upload_session':
        if (state.upload!.state === 'aborted') return { kind: 'expired', state: 'aborted' };
        return session(state.upload!);
      case 'service_space_process_upload':
        return {
          operationState: state.operation.state,
          teamId: TEAM,
          uploadId: state.upload ? UPLOAD : null,
          uploadState: state.upload?.state ?? null
        };
      case 'service_mark_space_upload_completing':
        if (args.p_content_id !== state.upload!.contentId) throw { message: 'CHECKSUM_MISMATCH' };
        state.upload!.state = 'completing';
        return session(state.upload!);
      case 'service_reject_space_upload':
        return null;
      case 'service_complete_space_upload':
        state.upload!.state = 'committed';
        return snapshot(OUTPUT, state.upload!.contentId, BYTES.length, 'Clip-compressed.mp4');
      case 'service_finalize_space_process_output': {
        const reused = state.operation.state === 'succeeded';
        if (!reused) {
          state.finalizes += 1;
          state.operation = { state: 'succeeded', resultMaterialId: OUTPUT };
        }
        return { operationId: OPERATION, state: 'succeeded', materialId: OUTPUT, reused };
      }
      case 'service_link_transcript_companion':
        state.links.push(args);
        return null;
      case 'service_abort_space_upload':
        state.upload!.state = 'aborted';
        return { aborted: true };
      case 'space_storage_journal_write':
        return true;
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
  return { rpc, state };
}

function fakeBucket(listed: () => SpaceListedPart[]) {
  const calls: string[] = [];
  const bucket: SpaceUploadBucket = {
    createMultipart: vi.fn(async () => {
      calls.push('create');
      return 'r2-upload-1';
    }),
    signPart: vi.fn(async (_key, _uploadId, partNumber, md5) => {
      calls.push(`sign ${partNumber}:${md5}`);
      return {
        partNumber,
        url: `https://acct.r2.cloudflarestorage.com/soty-spaces-beta/x?partNumber=${partNumber}`,
        contentMd5: md5,
        expiresAt: '2026-11-28T00:10:00.000Z'
      };
    }),
    listParts: vi.fn(async () => {
      calls.push('list');
      return listed();
    }),
    completeMultipart: vi.fn(async () => {
      calls.push('complete');
      return { etag: '"x-1"' };
    }),
    abortMultipart: vi.fn(async () => {
      calls.push('abort');
    }),
    head: vi.fn(async () => null)
  };
  return { bucket, calls };
}

async function grantKey() {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(7),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function deps(
  rpc: ProcessDeps['rpc'],
  bucket: SpaceUploadBucket | null,
  actorId: string | null = ACTOR
): Promise<ProcessDeps> {
  return {
    actorId,
    rpc,
    bucket,
    readGrant: {
      environment: 'beta',
      keyVersion: 1,
      key: await grantKey(),
      filesOrigin: 'https://files-beta.soty.pp.ua'
    },
    journal: async () => true,
    operationId: '05734000-0000-4000-8000-0000000000ff',
    client: { kind: 'agent', version: '1.8.0+110' },
    ticket: (() => {
      let n = 0;
      return () => `ticket-${++n}-`.padEnd(43, 'x');
    })()
  };
}

const startBody = {
  teamId: TEAM,
  materialId: SOURCE,
  destinationFolderId: null,
  idempotencyKey: 'process-run-key-0001',
  toolId: 'compressor',
  outputName: 'Clip-compressed.mp4',
  conflictMode: 'keep_both',
  agentContractVersion: 1,
  toolContractVersion: 3
};

const names = (rpc: ReturnType<typeof fakeWorld>['rpc']) =>
  rpc.mock.calls
    .map(call => call[0])
    .filter(
      name =>
        name !== 'space_storage_journal_write' && !name.startsWith('service_space_storage_context')
    );

describe('space-storage /process/start (057 T035)', () => {
  it('opens a run on the R2 source and hands the agent contract-3 grants', async () => {
    const world = fakeWorld();
    const started = await startSpaceProcess(
      parseProcessStartCommand(startBody),
      await deps(world.rpc, null)
    );
    expect(started).toMatchObject({
      operationId: OPERATION,
      state: 'running',
      agentContractVersion: 3,
      sourceGrant: { purpose: 'process_input' },
      finalizeGrant: { purpose: 'finalize' }
    });
    expect(names(world.rpc)).toEqual([
      'service_space_process_source',
      'service_start_team_operation',
      'service_set_team_operation_intent',
      'service_transition_team_operation',
      'issue_team_transfer_grant',
      'issue_team_transfer_grant'
    ]);
    const start = world.rpc.mock.calls.find(call => call[0] === 'service_start_team_operation')!;
    expect(start[1]).toMatchObject({
      p_team: TEAM,
      p_kind: 'process',
      p_source_material: SOURCE,
      p_destination_folder: ROOT,
      p_reserved_name_key: 'clip-compressed.mp4',
      p_bytes_total: 400
    });
    // Only hashes of the tickets reach the database.
    const issued = world.state.grants.map(grant => String(grant.p_token_hash));
    expect(issued.every(hash => /^\\x[0-9a-f]{64}$/u.test(hash))).toBe(true);
    expect(issued).not.toContain(started.sourceGrant.ticket);
    expect(world.state.grants[0]).toMatchObject({ p_purpose: 'process_input', p_material: SOURCE });
    expect(world.state.grants[1]).toMatchObject({ p_purpose: 'finalize' });
  });

  it('plans the output name with the Drive rule: keep both adds a number', async () => {
    const world = fakeWorld({ childNames: ['Clip.mp4', 'Clip-compressed.mp4'] });
    await startSpaceProcess(parseProcessStartCommand(startBody), await deps(world.rpc, null));
    const intent = world.rpc.mock.calls.find(
      call => call[0] === 'service_set_team_operation_intent'
    )!;
    expect(intent[1]).toMatchObject({
      p_expected_name: 'Clip-compressed (2).mp4',
      p_mime_type: 'video/mp4',
      p_version_of_material: null,
      p_tool: 'compressor'
    });
  });

  it('refuses what an R2 space cannot do yet, before anything is opened', async () => {
    // A run over its own source would be a new version; R2 spaces have none yet.
    expect(() => parseProcessStartCommand({ ...startBody, versionOfMaterialId: SOURCE })).toThrow(
      'STORAGE_BACKEND_MISMATCH'
    );
    expect(() =>
      parseProcessStartCommand({ ...startBody, idempotencyKey: 'catalog-variant:abc-123' })
    ).toThrow('INVALID_INPUT');
    expect(() => parseProcessStartCommand({ ...startBody, toolId: 'translation' })).toThrow(
      'FEATURE_RETIRED'
    );
    const world = fakeWorld({ category: 'image' });
    await expect(
      startSpaceProcess(parseProcessStartCommand(startBody), await deps(world.rpc, null))
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(names(world.rpc)).toEqual(['service_space_process_source']);
    const old = fakeWorld();
    await expect(
      startSpaceProcess(
        parseProcessStartCommand({ ...startBody, toolContractVersion: 2 }),
        await deps(old.rpc, null)
      )
    ).rejects.toMatchObject({ code: 'AGENT_UPDATE_REQUIRED' });
  });
});

describe('space-storage /agent/source (057 T033)', () => {
  it('gives the agent a files-host URL for the source, with its size and content id', async () => {
    const world = fakeWorld();
    const source = await agentSource(
      { operationId: OPERATION, ticket: TICKET, purpose: 'process_input' },
      await deps(world.rpc, null, null)
    );
    expect(world.state.consumed).toEqual(['process_input']);
    expect(source.bytes).toBe(400);
    expect(source.contentId).toBe(SOURCE_CONTENT);
    const url = new URL(source.url);
    expect(url.origin).toBe('https://files-beta.soty.pp.ua');
    expect(url.pathname).toBe(`/t/${TEAM}/o/${SOURCE_CONTENT}`);
    expect(url.searchParams.get('g')).toBeTruthy();
    expect(Date.parse(source.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('refuses a spent ticket and a ticket of another operation', async () => {
    const spent = fakeWorld();
    spent.state.grantValid = false;
    await expect(
      agentSource(
        { operationId: OPERATION, ticket: TICKET, purpose: 'process_input' },
        await deps(spent.rpc, null, null)
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const other = fakeWorld();
    await expect(
      agentSource(
        {
          operationId: '05734000-0000-4000-8000-0000000000c9',
          ticket: TICKET,
          purpose: 'process_input'
        },
        await deps(other.rpc, null, null)
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('space-storage /process/output (057 T035)', () => {
  it('tells a protocol-2 agent to update without spending its ticket', async () => {
    const world = fakeWorld();
    await expect(
      startProcessOutput(
        {
          operationId: OPERATION,
          ticket: TICKET,
          bytes: BYTES.length,
          contentId: await outputContentId(),
          contentType: 'video/mp4',
          outputUploadProtocolVersion: 2
        },
        await deps(world.rpc, fakeBucket(() => []).bucket, null)
      )
    ).rejects.toMatchObject({ code: 'AGENT_UPDATE_REQUIRED' });
    expect(world.state.consumed).toEqual([]);
  });

  it('commits the output as the run result, and a repeated finalize changes nothing', async () => {
    const world = fakeWorld();
    const contentId = await outputContentId();
    const { bucket, calls } = fakeBucket(() => [
      { partNumber: 1, etag: PART_MD5, bytes: BYTES.length }
    ]);
    const d = await deps(world.rpc, bucket, null);
    const session = await startProcessOutput(
      {
        operationId: OPERATION,
        ticket: TICKET,
        bytes: BYTES.length,
        contentId,
        contentType: 'video/mp4',
        outputUploadProtocolVersion: 3
      },
      d
    );
    expect(session).toMatchObject({ kind: 'session', uploadId: UPLOAD, partCount: 1 });
    expect(world.state.admitted[0]).toMatchObject({
      teamId: TEAM,
      parentMaterialId: ROOT,
      name: 'Clip-compressed.mp4',
      contentType: 'video/mp4',
      ingress: 'agent_output',
      idempotencyKey: `process_output_${OPERATION}`,
      contentId
    });

    const signed = await signProcessOutputParts(
      {
        operationId: OPERATION,
        ticket: TICKET,
        uploadId: UPLOAD,
        parts: [{ partNumber: 1, md5: PART_MD5 }]
      },
      d
    );
    expect(signed.parts).toHaveLength(1);
    expect(calls).toContain(`sign 1:${PART_MD5}`);

    const finalized = await finalizeProcessOutput(
      { operationId: OPERATION, ticket: TICKET, uploadId: UPLOAD },
      d
    );
    expect(finalized).toEqual({
      operationId: OPERATION,
      state: 'succeeded',
      materialId: OUTPUT,
      reused: false
    });
    expect(calls).toContain('complete');

    const again = await finalizeProcessOutput(
      { operationId: OPERATION, ticket: TICKET, uploadId: UPLOAD },
      d
    );
    expect(again).toMatchObject({ materialId: OUTPUT, reused: true });
    expect(world.state.finalizes).toBe(1);
    expect(calls.filter(call => call === 'complete')).toHaveLength(1);
  });

  it('links a transcription to its video as the transcript companion', async () => {
    const world = fakeWorld({ tool: 'transcription' });
    const contentId = await outputContentId();
    const { bucket } = fakeBucket(() => [{ partNumber: 1, etag: PART_MD5, bytes: BYTES.length }]);
    const d = await deps(world.rpc, bucket, null);
    await startProcessOutput(
      {
        operationId: OPERATION,
        ticket: TICKET,
        bytes: BYTES.length,
        contentId,
        contentType: 'text/plain',
        outputUploadProtocolVersion: 3
      },
      d
    );
    await finalizeProcessOutput(
      {
        operationId: OPERATION,
        ticket: TICKET,
        uploadId: UPLOAD,
        audioFingerprint: 'f'.repeat(64)
      },
      d
    );
    expect(world.state.links).toEqual([
      {
        p_team: TEAM,
        p_video: SOURCE,
        p_companion: OUTPUT,
        p_fingerprint: 'f'.repeat(64),
        p_text: null
      }
    ]);
  });

  it('fails the run when the stored parts are not the declared output', async () => {
    const world = fakeWorld();
    const { bucket, calls } = fakeBucket(() => [
      { partNumber: 1, etag: 'b'.repeat(32), bytes: BYTES.length }
    ]);
    const d = await deps(world.rpc, bucket, null);
    await startProcessOutput(
      {
        operationId: OPERATION,
        ticket: TICKET,
        bytes: BYTES.length,
        contentId: await outputContentId(),
        contentType: 'video/mp4',
        outputUploadProtocolVersion: 3
      },
      d
    );
    await expect(
      finalizeProcessOutput({ operationId: OPERATION, ticket: TICKET, uploadId: UPLOAD }, d)
    ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(calls).not.toContain('complete');
    expect(world.state.finalizes).toBe(0);
    expect(world.state.transitions.at(-1)).toMatchObject({
      p_state: 'failed',
      p_error_code: 'CHECKSUM_MISMATCH'
    });
  });

  it('refuses parts for an upload that is not the operation output', async () => {
    const world = fakeWorld();
    const d = await deps(world.rpc, fakeBucket(() => []).bucket, null);
    await expect(
      signProcessOutputParts(
        {
          operationId: OPERATION,
          ticket: TICKET,
          uploadId: '05734000-0000-4000-8000-0000000000d9',
          parts: [{ partNumber: 1, md5: PART_MD5 }]
        },
        d
      )
    ).rejects.toBeInstanceOf(TeamFunctionError);
  });

  it('quiesced closes an open output session once and is safe to repeat', async () => {
    const world = fakeWorld();
    const { bucket, calls } = fakeBucket(() => []);
    const d = await deps(world.rpc, bucket, null);
    await startProcessOutput(
      {
        operationId: OPERATION,
        ticket: TICKET,
        bytes: BYTES.length,
        contentId: await outputContentId(),
        contentType: 'video/mp4',
        outputUploadProtocolVersion: 3
      },
      d
    );
    expect(await acknowledgeProcessQuiesced({ operationId: OPERATION, ticket: TICKET }, d)).toEqual(
      { acknowledged: true }
    );
    expect(world.state.upload?.state).toBe('aborted');
    expect(await acknowledgeProcessQuiesced({ operationId: OPERATION, ticket: TICKET }, d)).toEqual(
      { acknowledged: true }
    );
    expect(calls.filter(call => call === 'abort')).toHaveLength(1);
  });
});

describe('space-storage what a finished run leaves (057, deferred from T035)', () => {
  async function finishRun(tool: string, extra: Record<string, unknown> = {}, text = BYTES) {
    const world = fakeWorld({ tool });
    const contentId = await outputContentId();
    const { bucket } = fakeBucket(() => [{ partNumber: 1, etag: PART_MD5, bytes: BYTES.length }]);
    const reads: string[] = [];
    const reading = Object.assign(bucket, {
      rangeGet: vi.fn(async (key: string, start: number, end: number) => {
        reads.push(`${key} ${start}-${end}`);
        return text.slice(start, end + 1);
      })
    });
    const d = await deps(world.rpc, reading, null);
    await startProcessOutput(
      {
        operationId: OPERATION,
        ticket: TICKET,
        bytes: BYTES.length,
        contentId,
        contentType: 'text/plain',
        outputUploadProtocolVersion: 3
      },
      d
    );
    const done = await finalizeProcessOutput(
      { operationId: OPERATION, ticket: TICKET, uploadId: UPLOAD, ...extra },
      d
    );
    return { world, reads, contentId, done, d };
  }

  it('keeps a transcription text for search, bound to its content id, before linking it', async () => {
    const { world, reads, contentId } = await finishRun('transcription');
    expect(reads).toEqual([`t/${TEAM}/o/${contentId} 0-${BYTES.length - 1}`]);
    expect(world.state.transcripts).toEqual([
      {
        p_material: OUTPUT,
        p_content_id: contentId,
        p_expected_extension: 'txt',
        p_state: 'full',
        p_text: 'compressed',
        p_indexed_bytes: BYTES.length,
        p_error_code: null
      }
    ]);
    const order = world.rpc.mock.calls.map(([name]) => name);
    expect(order.indexOf('service_commit_space_transcript')).toBeLessThan(
      order.indexOf('service_link_transcript_companion')
    );
  });

  it('records an unreadable transcription as unavailable, and never fails the run', async () => {
    const world = fakeWorld({ tool: 'transcription' });
    const contentId = await outputContentId();
    const { bucket } = fakeBucket(() => [{ partNumber: 1, etag: PART_MD5, bytes: BYTES.length }]);
    const d = await deps(
      world.rpc,
      Object.assign(bucket, {
        rangeGet: vi.fn(async () => {
          throw new TeamFunctionError('STORAGE_UNAVAILABLE');
        })
      }),
      null
    );
    await startProcessOutput(
      {
        operationId: OPERATION,
        ticket: TICKET,
        bytes: BYTES.length,
        contentId,
        contentType: 'text/plain',
        outputUploadProtocolVersion: 3
      },
      d
    );
    await expect(
      finalizeProcessOutput({ operationId: OPERATION, ticket: TICKET, uploadId: UPLOAD }, d)
    ).resolves.toMatchObject({ state: 'succeeded', materialId: OUTPUT });
    expect(world.state.transcripts).toMatchObject([
      { p_state: 'unavailable', p_text: null, p_error_code: 'STORAGE_UNAVAILABLE' }
    ]);
  });

  it('does not read a transcript for any other tool', async () => {
    const { world, reads } = await finishRun('compressor');
    expect(reads).toEqual([]);
    expect(world.state.transcripts).toEqual([]);
  });

  it('records a re-stitch finding for the run, and only for a re-stitch', async () => {
    const prep = {
      detectorVersion: 3,
      detectedStartSeconds: 0.5,
      detectedEndSeconds: 9,
      profile: { width: 1080 },
      driveVersion: SOURCE_CONTENT
    };
    const restitch = await finishRun('restitch', { restitchPrep: prep });
    expect(restitch.world.state.preps).toEqual([{ p_operation: OPERATION, p_prep: prep }]);
    const other = await finishRun('compressor', { restitchPrep: prep });
    expect(other.world.state.preps).toEqual([]);
  });

  it('keeps the run succeeded when the prep record is refused', async () => {
    const world = fakeWorld({ tool: 'restitch' });
    const inner = world.rpc.getMockImplementation()!;
    world.rpc.mockImplementation(async (name, args) => {
      if (name === 'service_record_material_restitch_prep') throw { message: 'INVALID_INPUT' };
      return inner(name, args);
    });
    const contentId = await outputContentId();
    const { bucket } = fakeBucket(() => [{ partNumber: 1, etag: PART_MD5, bytes: BYTES.length }]);
    const d = await deps(world.rpc, bucket, null);
    await startProcessOutput(
      {
        operationId: OPERATION,
        ticket: TICKET,
        bytes: BYTES.length,
        contentId,
        contentType: 'video/mp4',
        outputUploadProtocolVersion: 3
      },
      d
    );
    await expect(
      finalizeProcessOutput(
        { operationId: OPERATION, ticket: TICKET, uploadId: UPLOAD, restitchPrep: {} },
        d
      )
    ).resolves.toMatchObject({ state: 'succeeded' });
  });
});
