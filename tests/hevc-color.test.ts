import { expect, it } from 'vitest';
import {
  hdrFilter,
  hdrToLinear709,
  hlgToScene,
  linearToBt709,
  pqToLinear
} from '../apps/agent/src/stitcher/hevc-color';
import {
  compatibilityArgs,
  parseCompatibilityMetadata
} from '../apps/agent/src/stitcher/hevc-normalize';
it('matches BT.2100 PQ and HLG reference points without clipping HDR linear light', () => {
  expect(pqToLinear(0)).toBe(0);
  expect(pqToLinear(1)).toBeCloseTo(100, 8);
  expect(pqToLinear(0.5080784215)).toBeCloseTo(1, 6);
  expect(hlgToScene(0)).toBe(0);
  expect(hlgToScene(0.5)).toBeCloseTo(1 / 12, 10);
  expect(hlgToScene(1)).toBeCloseTo(1, 6);
  for (const primaries of ['bt709', 'bt2020', 'smpte432'] as const) {
    const white = hdrToLinear709([1, 1, 1], 'pq', primaries);
    white.forEach(v => expect(v).toBeCloseTo(100, 6));
    const hlg = hdrToLinear709([0.75, 0.75, 0.75], 'hlg', primaries);
    hlg.forEach(v => expect(v).toBeCloseTo(2.031521, 5));
  }
  expect(linearToBt709(0)).toBe(0);
  expect(linearToBt709(1)).toBeCloseTo(1, 12);
  expect(linearToBt709(0.01)).toBeCloseTo(0.045, 10);
});
const raw = (transfer = 'bt709') => ({
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'hevc',
      width: 320,
      height: 180,
      r_frame_rate: '60000/1001',
      avg_frame_rate: '30000/1001',
      sample_aspect_ratio: '1:1',
      color_transfer: transfer,
      color_primaries: 'bt2020',
      color_space: 'bt2020nc',
      duration: '3',
      side_data_list: [{ rotation: 90 }]
    }
  ],
  format: { duration: '3' }
});
it('recognizes both HDR transfers, rotated/VFR sources and excludes attached pictures', () => {
  expect(parseCompatibilityMetadata(raw('smpte2084'))).toMatchObject({
    hdr: 'pq',
    rotation: 90,
    fps: 60000 / 1001
  });
  expect(parseCompatibilityMetadata(raw('arib-std-b67'))?.hdr).toBe('hlg');
  const input = raw();
  input.streams.unshift({
    ...input.streams[0]!,
    codec_name: 'mjpeg',
    disposition: { attached_pic: 1 }
  } as (typeof input.streams)[number]);
  expect(parseCompatibilityMetadata(input)?.codec).toBe('hevc');
  expect(parseCompatibilityMetadata({ streams: [] })).toBeNull();
  expect(
    parseCompatibilityMetadata({
      ...raw(),
      streams: [{ ...raw().streams[0], r_frame_rate: 'NaN/1', avg_frame_rate: '1/0' }]
    })
  ).toBeNull();
});
it('uses fixed relative LUT assets and no thread overrides at the unrestricted budget', () => {
  const metadata = parseCompatibilityMetadata(raw('smpte2084'))!;
  const args = compatibilityArgs(metadata, null);
  expect(args).not.toContain('-threads');
  expect(args).not.toContain('-filter_threads');
  expect(args[args.indexOf('-vf') + 1]).toContain('lut3d=file=hevc-linear.cube');
  expect(args).toContain('input.media');
  expect(args).toContain('normalized.mp4');
  expect(compatibilityArgs(metadata, 2)).toContain('-threads');
  expect(hdrFilter('hlg', 'bt2020', 4000, 'tv').join(',')).toContain('peak=10');
});
