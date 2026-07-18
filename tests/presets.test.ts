import { describe, expect, it } from 'vitest';
import { expectedDimensions } from '../packages/shared/src/types.js';
import {
  buildEstimateArgs,
  buildFfmpegArgs,
  videoArgs
} from '../apps/agent/src/ffmpeg/presets.js';
import { customEncoding, optimalEncoding } from './helpers.js';

describe('FFmpeg compression arguments', () => {
  it('uses CRF 26, H.264, compatible pixels and MP4 faststart in Optimal mode', () => {
    const args = buildFfmpegArgs('in.mov', 'out.mp4', optimalEncoding);
    expect(argumentAfter(args, '-crf')).toBe('26');
    expect(argumentAfter(args, '-c:v')).toBe('libx264');
    expect(argumentAfter(args, '-pix_fmt')).toBe('yuv420p');
    expect(argumentAfter(args, '-movflags')).toBe('+faststart');
    expect(argumentAfter(args, '-c:a')).toBe('copy');
  });

  it('preserves original frame rate and resolution in Optimal mode', () => {
    const args = buildFfmpegArgs('in.mov', 'out.mp4', optimalEncoding);
    expect(args).not.toContain('-vf');
    expect(args.join(' ')).not.toContain('fps=');
    expect(args.join(' ')).not.toContain('scale=');
  });

  it('applies a custom frame rate only when requested', () => {
    const args = buildFfmpegArgs('in.mov', 'out.mp4', {
      ...customEncoding,
      frameRate: 50,
      resolutionLimit: null
    });
    expect(argumentAfter(args, '-vf')).toBe('fps=50');
  });

  it('downscales the longest side, preserves aspect ratio and produces even dimensions', () => {
    const dimensions = expectedDimensions(1920, 1080, 721);
    expect(dimensions).toEqual({ width: 720, height: 406 });
    const args = buildFfmpegArgs('in.mov', 'out.mp4', {
      ...customEncoding,
      frameRate: null,
      resolutionLimit: 721
    });
    expect(argumentAfter(args, '-vf')).toContain('min(720,iw)');
    expect(argumentAfter(args, '-vf')).toContain('-2');
  });

  it('never upscales a source that is already below the requested limit', () => {
    expect(expectedDimensions(640, 360, 1080)).toEqual({ width: 640, height: 360 });
    expect(expectedDimensions(360, 640, 1080)).toEqual({ width: 360, height: 640 });
  });

  it('uses CRF without target bitrate in constant-quality mode', () => {
    const args = buildFfmpegArgs('in.mov', 'out.mp4', {
      ...customEncoding,
      crf: 18,
      rateControl: 'crf',
      videoBitrateKbps: null
    });
    expect(argumentAfter(args, '-crf')).toBe('18');
    expect(args).not.toContain('-b:v');
  });

  it('uses target bitrate without CRF in bitrate mode', () => {
    const args = buildFfmpegArgs('in.mov', 'out.mp4', {
      ...customEncoding,
      rateControl: 'bitrate',
      crf: 18,
      videoBitrateKbps: 4000
    });
    expect(args).not.toContain('-crf');
    expect(argumentAfter(args, '-b:v')).toBe('4000k');
    expect(argumentAfter(args, '-maxrate')).toBe('4000k');
    expect(argumentAfter(args, '-bufsize')).toBe('8000k');
  });

  it('uses the same video parameters for estimation and the final encode', () => {
    const settings = {
      ...customEncoding,
      frameRate: 25,
      resolutionLimit: 720,
      rateControl: 'bitrate' as const,
      videoBitrateKbps: 1800
    };
    const video = videoArgs(settings);
    const estimate = buildEstimateArgs('in.mov', 'sample.h264', 1, 3, settings);
    const final = buildFfmpegArgs('in.mov', 'out.mp4', settings);
    expect(containsSequence(estimate, video)).toBe(true);
    expect(containsSequence(final, video)).toBe(true);
  });

  it('keeps paths intact and never overwrites an existing output', () => {
    const args = buildFfmpegArgs('/tmp/Моє відео.mov', '/tmp/out file.mp4', optimalEncoding);
    expect(args).toContain('/tmp/Моє відео.mov');
    expect(args).toContain('/tmp/out file.mp4');
    expect(args).toContain('-n');
  });
});

function argumentAfter(args: string[], name: string) {
  return args[args.indexOf(name) + 1];
}

function containsSequence(values: string[], sequence: string[]) {
  return values.some((_, index) => sequence.every((value, offset) => values[index + offset] === value));
}
