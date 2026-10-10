import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioFingerprint } from '../apps/agent/src/team-bridge/audio-fingerprint.js';
import { TeamOperationEvents } from '../apps/agent/src/team-bridge/events.js';
import {
  TeamProcessBridge,
  type TeamProcessDelegate,
  type TeamProcessTransfer
} from '../apps/agent/src/team-bridge/process.js';
import { TeamTransferClient } from '../apps/agent/src/team-bridge/transfer.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * Feature 012 (T004): a transcription reports what the video sounds like — a SHA-256 of its
 * decoded audio — and the agent carries it to the finalize that links the transcript.
 */

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soty-audio-fingerprint-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => removeTemporaryDirectory(dir)));
});

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;

function grant(purpose: 'process_input' | 'finalize') {
  return {
    ticket: `opaque-${purpose}-ticket-with-enough-entropy`,
    purpose,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxRangeBytes: 4,
    maxUses: 8
  } as const;
}

/** Stands in for ffmpeg: prints fixed "samples", or nothing, and exits as told. */
function fakeDecoder(output: string, code = 0) {
  return () =>
    spawn(process.execPath, [
      '-e',
      `process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${code};`
    ]);
}

describe('the decoded-audio fingerprint', () => {
  it('hashes the decoded samples, not the file', async () => {
    const value = await audioFingerprint({ file: 'unused', spawnChild: fakeDecoder('pcm-bytes') });
    // sha256("pcm-bytes")
    expect(value).toMatch(/^[a-f0-9]{64}$/u);
    const again = await audioFingerprint({ file: 'other', spawnChild: fakeDecoder('pcm-bytes') });
    expect(again).toBe(value);
  });

  it('answers null for no audio, a failed decode, or a cancel', async () => {
    await expect(audioFingerprint({ file: 'x', spawnChild: fakeDecoder('') })).resolves.toBeNull();
    await expect(
      audioFingerprint({ file: 'x', spawnChild: fakeDecoder('partial', 1) })
    ).resolves.toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(
      audioFingerprint({ file: 'x', signal: controller.signal, spawnChild: fakeDecoder('pcm') })
    ).resolves.toBeNull();
    await expect(
      audioFingerprint({ file: 'x', command: path.join(os.tmpdir(), 'no-such-ffmpeg-binary') })
    ).resolves.toBeNull();
  });

  it.skipIf(!hasFfmpeg)(
    'matches a re-wrapped copy of the same audio and differs for other audio',
    async () => {
      const dir = await root();
      const original = path.join(dir, 'speech.mp4');
      const rewrapped = path.join(dir, 'speech.mkv');
      const other = path.join(dir, 'other.mp4');
      const run = (args: string[]) =>
        expect(spawnSync(FFMPEG, ['-v', 'error', '-y', ...args]).status).toBe(0);
      run([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        original
      ]);
      run(['-i', original, '-c', 'copy', rewrapped]);
      run([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:duration=1',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        other
      ]);
      const [a, b, c] = await Promise.all(
        [original, rewrapped, other].map(file => audioFingerprint({ file, command: FFMPEG }))
      );
      expect(a).toMatch(/^[a-f0-9]{64}$/u);
      expect(b).toBe(a);
      expect(c).not.toBe(a);
    },
    60_000
  );
});

describe('the fingerprint reaches the finalize', () => {
  it('is handed from the delegate to the upload', async () => {
    const dir = await root();
    const source = path.join(dir, 'source.mp4');
    const output = path.join(dir, 'transcript.txt');
    await writeFile(source, 'source');
    await writeFile(output, 'words');
    const FP = 'a'.repeat(64);
    const transfer: TeamProcessTransfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: dir,
        file: source,
        sizeBytes: 6,
        sourceVersion: '1',
        sourceChecksum: null,
        cleanup: vi.fn().mockResolvedValue(undefined)
      }),
      uploadResult: vi.fn().mockResolvedValue({
        operationId: 'operation-fp',
        state: 'succeeded',
        materialId: 'txt-1',
        reused: false
      })
    };
    const delegate: TeamProcessDelegate = vi.fn().mockResolvedValue({
      file: output,
      mimeType: 'text/plain',
      sizeBytes: 5,
      audioFingerprint: FP
    });
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { transcription: delegate },
      events: new TeamOperationEvents(() => undefined)
    });
    await bridge.process({
      operationId: 'operation-fp',
      toolId: 'transcription',
      options: {},
      sourceGrant: grant('process_input'),
      finalizeGrant: grant('finalize'),
      transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
      cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops'
    });
    expect(transfer.uploadResult).toHaveBeenCalledWith(
      expect.objectContaining({ audioFingerprint: FP }),
      expect.anything()
    );
  });

  it('is sent with the finalize call, and only when well-formed', async () => {
    const dir = await root();
    const output = path.join(dir, 'transcript.txt');
    await writeFile(output, 'words');
    const bodies: unknown[] = [];
    const respond = (value: unknown, status = 200) =>
      new Response(JSON.stringify({ ok: true, value }), { status });
    const run = async (audioFingerprint: string) => {
      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        const target = String(url);
        if (target.endsWith('/process/output/start')) {
          return respond(
            {
              operationId: 'operation-fp',
              sessionUri: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              chunkMultiple: 256 * 1024
            },
            202
          );
        }
        if (target.endsWith('/process/output/finalize')) {
          bodies.push(JSON.parse(String(init?.body)));
          return respond({
            operationId: 'operation-fp',
            state: 'succeeded',
            materialId: 'txt-1',
            reused: false
          });
        }
        return new Response(JSON.stringify({ id: 'drive-txt-1' }), { status: 200 });
      });
      await new TeamTransferClient({ fetchImpl, temporaryRoot: dir }).uploadResult(
        {
          operationId: 'operation-fp',
          cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops',
          finalizeGrant: grant('finalize'),
          file: output,
          mimeType: 'text/plain',
          sizeBytes: 5,
          audioFingerprint
        },
        new AbortController().signal
      );
    };
    await run('b'.repeat(64));
    await run('not-a-fingerprint');
    expect(bodies[0]).toMatchObject({ audioFingerprint: 'b'.repeat(64) });
    expect(bodies[1]).not.toHaveProperty('audioFingerprint');
  });
});
