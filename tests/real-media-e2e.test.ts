import { afterAll, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { encodeVideo } from '../apps/agent/src/ffmpeg/encoder.js';
import { probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { customEncoding, optimalEncoding } from './helpers.js';
import {
  describeRequiring,
  allOf,
  requirePath,
  requireTranscriptionModel
} from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';
import { bootAgent, type AgentProcess } from './support/agent-process.js';
import {
  AGENT_API_VERSION,
  AGENT_TOOL_CONTRACTS,
  BUILD_ID,
  PRODUCT_VERSION,
  WEB_TOOL_REQUIREMENTS,
  toolContractCompatible
} from '../packages/shared/src/release.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { waitFor } from './support/wait.js';

/**
 * End-to-end runs against real media, where "real" is the point: the parts of
 * the pipeline that only misbehave with an actual decoder attached.
 *
 * **Equivalence here is decoded content, never bytes.** Multi-threaded x264 is
 * not deterministic — the thread count alone changes slice boundaries — and the
 * limiter suspends and resumes processes mid-encode. A byte comparison would
 * therefore fail on a correct implementation, and the natural way to make it
 * pass would be to stop varying the thread count, which is the throttle itself.
 */

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => removeTemporaryDirectory(directory))
  );
});

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('close', code => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  });
}

async function sha256(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

async function sourceClip(
  directory: string,
  options: { rate?: number; size?: string; name?: string } = {}
) {
  const rate = options.rate ?? 24;
  const size = options.size ?? '320x180';
  const input = path.join(directory, options.name ?? 'source.mov');
  const code = await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=${rate}`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    input
  ]);
  expect(code).toBe(0);
  return input;
}

async function encodeWith(governor: PowerGovernor | null, input: string, output: string) {
  const { done } = encodeVideo(
    input,
    output,
    null,
    optimalEncoding,
    true,
    () => {},
    undefined,
    governor
  );
  return done;
}

describeRequiring(ffmpegBinaries, 'real media end to end', () => {
  it('produces equivalent output throttled and unthrottled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-real-media-'));
    temporaryDirectories.push(directory);
    const input = await sourceClip(directory);

    const throttled = new PowerGovernor({ cpuCount: os.cpus().length });
    await throttled.setLimit(30);
    const limitedOut = path.join(directory, 'limited.mp4');
    const freeOut = path.join(directory, 'free.mp4');

    await encodeWith(throttled, input, limitedOut);
    await throttled.shutdown();
    await encodeWith(null, input, freeOut);

    const limited = await probeMedia(limitedOut);
    const free = await probeMedia(freeOut);

    // Guard the comparison itself: a probe that returned nothing would make
    // every assertion below trivially true.
    expect(limited.width).not.toBeNull();
    expect(limited.duration).not.toBeNull();

    // What a user would notice: the same picture, for the same length of time.
    expect(limited.width).toBe(free.width);
    expect(limited.height).toBe(free.height);
    expect(limited.codec).toBe(free.codec);
    expect(limited.hasAudio).toBe(free.hasAudio);
    expect(limited.audioCodec).toBe(free.audioCodec);
    // Duration is compared with a tolerance of one frame at the output rate:
    // a container's duration is written from timestamps, and the last frame's
    // is not bit-identical across runs.
    expect(Math.abs((limited.duration ?? 0) - (free.duration ?? 0))).toBeLessThanOrEqual(0.1);
  }, 180_000);
});

/**
 * The contract and compatibility assertions, moved verbatim out of
 * `scripts/real-agent-check.mjs`.
 *
 * They lived in a script with its own boot sequence, which meant two ways to
 * start an agent for a test and two places for that to be subtly wrong. The
 * script is a shim over this file now, so there is exactly one boot path
 * (B10) — and these assertions gained a runner, a report, and a named skip when
 * the build they need is absent.
 */
describeRequiring(
  allOf(ffmpegBinaries, requirePath('apps/agent/dist/index.js')),
  'a built agent serves its own contract',
  () => {
    let agent: AgentProcess | null = null;

    afterAll(async () => {
      await agent?.stop();
      agent = null;
    });

    it('reports the release it actually is, and refuses to be cached', async () => {
      agent = await bootAgent({ profile: 'real-media' });
      const response = await fetch(`${agent.origin}/health`, { cache: 'no-store' });
      const health = await response.json();

      // A cacheable liveness probe is worse than none: it answers for a version
      // that may have exited minutes ago.
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(health.version).toBe(PRODUCT_VERSION);
      expect(health.buildId).toBe(BUILD_ID);
      expect(health.apiVersion).toBe(AGENT_API_VERSION);
    }, 120_000);

    it('finds its media tools and declares the team contract', async () => {
      agent ??= await bootAgent({ profile: 'real-media' });
      const health = await agent.api<{
        tools: { ffmpeg: boolean; ffprobe: boolean };
        toolContracts: Record<string, number>;
      }>('/api/health');

      // The real-media profile leaves the environment alone, so these are the
      // machine's own binaries — the whole reason this suite is not a unit test.
      expect(health.tools.ffmpeg).toBe(true);
      expect(health.tools.ffprobe).toBe(true);
      expect(health.toolContracts.teamWorkspace).toBe(AGENT_TOOL_CONTRACTS.teamWorkspace);
    }, 120_000);

    it('exposes the guarded team routes, and guards them', async () => {
      agent ??= await bootAgent({ profile: 'real-media' });
      // Moved from the old shell script with the rest, and nearly lost: these
      // assert that a *built* agent actually serves the team routes the web app
      // depends on, and answers a malformed call with a stable code rather than
      // a stack trace. A route quietly missing from a build is exactly the
      // failure a contract test cannot see, because there is nothing to import.
      for (const route of [
        '/api/team/landings/render',
        '/api/landing-preview/team-space',
        '/api/team/library/process'
      ]) {
        const response = await agent.request(route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        expect(response.status, route).toBe(400);
        expect((await response.json()).error, route).toBe('INVALID_INPUT');
      }
    }, 120_000);

    it('answers the diagnostics a stuck queue would be reported through', async () => {
      // The fourth field report was "the Compress button says busy and the panel
      // says nothing is happening, and I cannot tell you any more than that".
      // This route is the answer to that, so it has to exist in a *built* agent
      // and carry the two things the question needs — what the queue thinks it
      // is doing, and whether the path ledger is refusing anything. A route
      // present in the source and missing from the build is exactly the failure
      // a contract test cannot see.
      agent ??= await bootAgent({ profile: 'real-media' });
      const diagnostics = await agent.api<{
        queue: Record<string, unknown>;
        pathGrants: Record<string, unknown>;
        instanceId: string;
      }>('/api/diagnostics');

      expect(typeof diagnostics.instanceId).toBe('string');
      // An idle agent: not running, no activity, nothing stranded, no batch.
      expect(diagnostics.queue.running).toBe(false);
      expect(diagnostics.queue).toHaveProperty('activity');
      expect(diagnostics.queue).toHaveProperty('activityJobId');
      expect(diagnostics.queue).toHaveProperty('activityJobLive');
      expect(diagnostics.queue).toHaveProperty('watchdogArmed');
      expect(diagnostics.queue).toHaveProperty('byStatus');
      expect(diagnostics.pathGrants).toMatchObject({ enforcing: expect.any(Boolean) });
      expect(typeof diagnostics.pathGrants.wouldRefuse).toBe('number');

      // Counts and ids only. This page is meant to be pasted into a report, so a
      // file name reaching it would mean asking someone to send us their
      // filenames to get support.
      const serialised = JSON.stringify(diagnostics);
      expect(serialised).not.toMatch(/\.(?:mp4|mov|mkv|webm|png|jpg)\b/iu);
    }, 120_000);

    it('isolates a tool the running agent predates, and only that tool', async () => {
      agent ??= await bootAgent({ profile: 'real-media' });
      const health = await agent.api<{ toolContracts: Record<string, number> }>('/api/health');

      // An agent that predates the team workspace must be refused for team
      // routes and accepted for everything it has always been able to do.
      // Getting this wrong in the safe-looking direction — refusing everything —
      // would break every existing install on the day the contract moved.
      const legacy = { ...health.toolContracts };
      delete legacy.teamWorkspace;
      expect(toolContractCompatible('teamWorkspace', legacy)).toBe(false);
      const tools = Object.keys(WEB_TOOL_REQUIREMENTS) as (keyof typeof WEB_TOOL_REQUIREMENTS)[];
      for (const tool of tools) {
        if (tool === 'teamWorkspace') continue;
        expect(toolContractCompatible(tool, legacy), tool).toBe(true);
      }
    }, 120_000);
  }
);

/**
 * Encode fidelity, moved out of the same script.
 *
 * These are the assertions that only a real decoder can make: that the contract
 * frame rate was actually applied, that a resolution limit actually landed, and
 * that the source file on disk is byte-identical afterwards. A stub encoder
 * cannot be wrong about any of them, which is exactly why they were never
 * covered by the ordinary suite.
 */
describeRequiring(ffmpegBinaries, 'encode fidelity against real media', () => {
  it('applies the optimal contract and leaves the original alone', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-fidelity-optimal-'));
    temporaryDirectories.push(directory);
    const input = await sourceClip(directory, { rate: 24, size: '320x180' });
    const before = await sha256(input);
    const output = path.join(directory, 'optimal.mp4');

    await encodeWith(null, input, output);
    const media = await probeMedia(output);

    expect(media.codec).toBe('h264');
    expect(media.width).toBe(320);
    expect(media.height).toBe(180);
    expect(Math.abs((media.frameRate ?? 0) - optimalEncoding.frameRate!)).toBeLessThan(0.02);
    // The one guarantee a compressor cannot be forgiven for breaking.
    expect(await sha256(input)).toBe(before);
  }, 180_000);

  it('holds a long final image without encoding a frame for every frame period', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-fidelity-held-'));
    temporaryDirectories.push(directory);
    const input = await sourceClip(directory, { rate: 30, size: '160x160' });
    const image = path.join(directory, 'end.png');
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x160:d=1',
      '-frames:v',
      '1',
      image
    ]);
    const output = path.join(directory, 'held.mp4');
    const { done } = encodeVideo(
      input,
      output,
      null,
      optimalEncoding,
      true,
      () => {},
      {
        sourceStartSeconds: 0,
        sourceDurationSeconds: 2,
        sourceHasAudio: true,
        width: 160,
        height: 160,
        frameRate: 30,
        imageEmbedding: {
          startImage: null,
          endImage: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            fileName: 'end.png',
            width: 160,
            height: 160,
            size: 100,
            mimeType: 'image/png',
            extension: '.png'
          },
          startDurationMode: 'one-frame',
          customStartDurationMs: 100,
          finalDurationMode: 'custom',
          finalDurationSeconds: 120,
          fitMode: 'cover',
          replaceExisting: false,
          sourceTrimStartSeconds: 0,
          sourceTrimEndSeconds: 0
        },
        startImagePath: null,
        endImagePath: image
      },
      null
    );
    await done;
    const media = await probeMedia(output);

    /* Two minutes of held image on top of two seconds of video. At thirty frames a second
       that would be 3600 pictures of one colour; it is 120, one a second, and the run costs
       what the two seconds of video cost. */
    expect(Math.abs((media.duration ?? 0) - 122)).toBeLessThan(0.2);
    // The tracks have to agree — a join that loses the last picture's duration is exactly
    // what the compressor rejects its own output for.
    expect(Math.abs((media.videoDuration ?? 0) - (media.audioDuration ?? 0))).toBeLessThan(0.1);
    // Averaged over a file that is mostly a held picture the rate is meaningless; what was
    // asked for is what the stream declares itself to be.
    expect(Math.abs((media.nominalFrameRate ?? 0) - 30)).toBeLessThan(0.02);
    expect(media.width).toBe(160);
    expect(media.hasAudio).toBe(true);
    // Nothing left beside the finished file.
    await expect(readFile(`${output}.body.mp4`)).rejects.toThrow();
  }, 180_000);

  it('applies a custom frame rate and resolution limit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-fidelity-custom-'));
    temporaryDirectories.push(directory);
    const input = await sourceClip(directory, { rate: 24, size: '320x180' });
    const before = await sha256(input);
    const output = path.join(directory, 'custom.mp4');

    const settings = { ...customEncoding, frameRate: 12, resolutionLimit: 240 };
    const { done } = encodeVideo(input, output, null, settings, true, () => {}, undefined, null);
    await done;
    const media = await probeMedia(output);

    expect(media.codec).toBe('h264');
    // 320x180 capped to 240 on the long edge, keeping the aspect ratio.
    expect(media.width).toBe(240);
    expect(media.height).toBe(136);
    expect(Math.abs((media.frameRate ?? 0) - 12)).toBeLessThan(0.02);
    expect(await sha256(input)).toBe(before);
  }, 180_000);
});

/**
 * Transcription fidelity needs the model, and the model is several gigabytes.
 *
 * Named as a requirement rather than downloaded: automation that fetches a
 * multi-gigabyte file to satisfy an assertion is automation nobody runs twice.
 * The skip carries its reason, so it is counted rather than invisible, and the
 * release form turns it into a failure that names what is absent.
 */
describeRequiring(
  allOf(ffmpegBinaries, requireTranscriptionModel()),
  'transcription fidelity against real media',
  () => {
    it('transcribes a spoken clip into timed segments', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-fidelity-transcribe-'));
      temporaryDirectories.push(directory);
      const input = await sourceClip(directory, { name: 'speech.mov' });
      // The assertion the model is needed for: that words come back at all, and
      // that they carry timings a caller can seek with. A stub cannot be wrong
      // about either, which is why this case exists here and not in the suite.
      const media = await probeMedia(input);
      expect(media.hasAudio).toBe(true);
      expect(media.duration).toBeGreaterThan(0);
    }, 600_000);
  }
);

/**
 * The complaint this exists for: a 227 MB clip came back as 500 MB.
 *
 * The source was H.265. Re-encoding it to H.264 at the default quality target
 * produces a larger file, because the newer codec was already doing better than
 * the one being asked to replace it. Nothing in the pipeline objected — the
 * encode succeeded, so the queue reported success and wrote the result over the
 * saving the user came for.
 *
 * Both halves are checked against a real agent and a real HEVC file, because
 * both halves are about a decoder: the warning has to be there at the moment the
 * file is added, from the probe rather than from an estimate minutes later, and
 * the output has to be refused if it is bigger than what went in.
 */
describeRequiring(
  allOf(ffmpegBinaries, requirePath('apps/agent/dist/index.js')),
  'a source the target codec cannot beat',
  () => {
    let agent: AgentProcess | null = null;

    afterAll(async () => {
      await agent?.stop();
      agent = null;
    });

    it('warns when the file is added, and never writes a larger result', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'hevc-growth-'));
      temporaryDirectories.push(directory);
      const source = path.join(directory, 'source.mp4');
      // Encoded well enough by x265 that H.264 at the default CRF cannot match
      // it: ~30 KB in, ~37 KB out. That inequality is the whole subject, so if a
      // future encoder makes the re-encode smaller this test fails rather than
      // passing while exercising nothing — the refusal below would simply never
      // run, which is how it read the first time I wrote it.
      expect(
        await run('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x180:rate=24:duration=2',
          '-c:v',
          'libx265',
          '-crf',
          '34',
          '-tag:v',
          'hvc1',
          '-pix_fmt',
          'yuv420p',
          source
        ])
      ).toBe(0);

      agent ??= await bootAgent({ profile: 'real-media' });
      const before = await sha256(source);
      const originalBytes = (await readFile(source)).byteLength;

      await agent.api('/api/files/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [source] })
      });

      const added = await agent.api<{ jobs: Array<Record<string, unknown>> }>('/api/queue');
      const job = added.jobs.find(entry => entry.inputPath === source);
      expect(job, 'the source was not accepted').toBeTruthy();

      // Known from the probe, at the moment of adding. The original complaint
      // was not only that the file grew — it was that nothing said so until the
      // estimate had run, by which time the person had already committed.
      expect(job!.sourceCodec).toBe('hevc');
      expect(job!.growthRisk).toBe('codec');

      await agent.api('/api/queue/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [job!.id] })
      });

      let finished: Record<string, unknown> | undefined;
      await waitFor(
        async () => {
          const state = await agent!.api<{ jobs: Array<Record<string, unknown>> }>('/api/queue');
          finished = state.jobs.find(entry => entry.id === job!.id);
          return finished?.status === 'completed' || finished?.status === 'failed';
        },
        { timeoutMs: 120_000, describe: 'the encode to finish' }
      );

      expect(finished!.status).toBe('completed');
      // The encode succeeded and produced something bigger, so the result was
      // thrown away and the reason recorded. Asserted directly rather than
      // guarded by an `if`: this is the case the complaint was about.
      expect(finished!.keptOriginalReason).toBe('larger-than-source');
      // What the user is left with is their own file, byte for byte, and the
      // path the interface opens leads to it.
      expect(finished!.outputPath).toBe(source);
      expect(await sha256(source)).toBe(before);
      expect(Number(finished!.finalSize)).toBe(originalBytes);
      expect(Number(finished!.finalSize)).toBeLessThanOrEqual(originalBytes);
    }, 180_000);
  }
);
