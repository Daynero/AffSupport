import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs } from '../apps/agent/src/ffmpeg/presets.js';
describe('preset argument arrays', () => {
  it('defines Quality without resizing', () => { const a=buildFfmpegArgs('in.mov','out.mp4','quality'); expect(a).toContain('24'); expect(a).toContain('copy'); expect(a).not.toContain('-vf'); });
  it('defines Balanced with 720 and non-increasing 24 FPS', () => { const a=buildFfmpegArgs('in.mov','out.mp4','balanced'); expect(a).toContain('26'); expect(a.join(' ')).toContain('min(720'); expect(a.join(' ')).toContain('min(24,source_fps)'); expect(a).toContain('96k'); });
  it('defines Ultra Small with 550, 20 FPS and mono audio', () => { const a=buildFfmpegArgs('in.mov','out.mp4','ultra-small'); expect(a).toContain('30'); expect(a).toContain('veryslow'); expect(a.join(' ')).toContain('min(550'); expect(a.join(' ')).toContain('min(20,source_fps)'); expect(a).toContain('48k'); expect(a).toContain('1'); });
  it('passes paths as intact arguments and never enables overwrite', () => { const a=buildFfmpegArgs('/tmp/Моє відео.mov','/tmp/out file.mp4','balanced'); expect(a).toContain('/tmp/Моє відео.mov'); expect(a).toContain('/tmp/out file.mp4'); expect(a).toContain('-n'); });
  it('caps Quality frame rate with the chosen rate', () => { const a=buildFfmpegArgs('in.mov','out.mp4','quality',72); expect(a.join(' ')).toContain("fps='min(72,source_fps)'"); expect(a.join(' ')).not.toContain('scale='); });
  it('never lets a higher frame rate raise a preset above its own cap', () => { expect(buildFfmpegArgs('in.mov','out.mp4','balanced',120).join(' ')).toContain('min(24,source_fps)'); expect(buildFfmpegArgs('in.mov','out.mp4','ultra-small',120).join(' ')).toContain('min(20,source_fps)'); });
});
