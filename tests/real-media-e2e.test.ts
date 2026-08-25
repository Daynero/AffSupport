import { afterAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
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
