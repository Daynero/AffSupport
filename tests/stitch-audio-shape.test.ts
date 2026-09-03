import { describe, expect, it } from 'vitest';
import {
  audioShapeDisagreements,
  audioShapeFromProbe,
  buildAudioShapeProbeArgs
} from '../apps/agent/src/stitcher/audio-shape.js';

/**
 * The silent re-stitch, in a test.
 *
 * A file came back with the picture cut correctly and no sound anywhere: QuickTime, Safari,
 * Telegram, Finder. FFmpeg read it perfectly, which is why nothing we measured saw it — FFmpeg
 * re-syncs an AAC stream frame by frame, while CoreAudio reads the track's one declared
 * configuration and decodes everything against it. The concat demuxer writes exactly that one
 * configuration, taken from the first input. So AAC-LC silence in front of an HE-AAC body
 * declares LC and then delivers frames that are not, and the player gives up.
 *
 * Measured on the real thing: the HE-AAC body joined this way gave `ExtAudioFileRead failed
 * ('bada')` and 13 s of an 18 s file; the same body re-encoded to AAC-LC decoded all 18 s.
 */

const lc = { codec: 'aac', profile: 'LC', sampleRate: 44100, channels: 2 };

describe('the shapes a copied join is allowed to mix', () => {
  it('asks for exactly the fields a sample description declares', () => {
    const args = buildAudioShapeProbeArgs('/tmp/segment.mp4');
    expect(args).toContain('a:0');
    const entries = args[args.indexOf('-show_entries') + 1] ?? '';
    expect(entries).toContain('profile');
    expect(entries).toContain('codec_name');
    expect(entries).toContain('sample_rate');
    expect(entries).toContain('channels');
  });

  it('reads a stream description ffprobe returned', () => {
    const shape = audioShapeFromProbe({
      streams: [{ codec_name: 'aac', profile: 'HE-AAC', sample_rate: '44100', channels: 2 }]
    });
    expect(shape).toEqual({ codec: 'aac', profile: 'HE-AAC', sampleRate: 44100, channels: 2 });
  });

  it('reports no audio as absent rather than as a shape', () => {
    expect(audioShapeFromProbe({ streams: [] })).toBeNull();
  });

  it('passes parts that agree', () => {
    expect(audioShapeDisagreements([lc, lc, lc])).toEqual([]);
  });

  it('passes a run with no sound anywhere', () => {
    expect(audioShapeDisagreements([null, null, null])).toEqual([]);
  });

  it('catches the AAC profile that produced a silent file', () => {
    const body = { ...lc, profile: 'HE-AAC' };
    // Second in the list: silence, body, silence — the body is what disagrees.
    expect(audioShapeDisagreements([lc, body, lc])).toContain('segment-2-profile');
  });

  it('catches a rate or a channel count that would not survive the join', () => {
    expect(audioShapeDisagreements([lc, { ...lc, sampleRate: 48000 }])).toContain(
      'segment-2-sample-rate'
    );
    expect(audioShapeDisagreements([lc, { ...lc, channels: 1 }])).toContain('segment-2-channels');
  });

  it('catches a part with no sound among parts that have some', () => {
    // The joined track simply stops there, which is the same silence by another route.
    expect(audioShapeDisagreements([lc, null, lc])).toContain('segment-2-audio-presence');
  });

  it('has nothing to compare when there is one part', () => {
    expect(audioShapeDisagreements([{ ...lc, profile: 'HE-AAC' }])).toEqual([]);
  });
});
