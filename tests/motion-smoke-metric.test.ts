import { describe, expect, it } from 'vitest';
import { analyzeTransition, distance, lumaOf } from '../scripts/lib/motion-metric.mjs';

const SIZE = 400;

function solid(value: number) {
  return new Float32Array(SIZE).fill(value);
}

/** A "page": a shared background with one card, at the start or at the end. */
function page(cardSide: 'left' | 'right') {
  const frame = new Float32Array(SIZE).fill(100);
  const from = cardSide === 'left' ? 0 : SIZE * 0.75;
  for (let index = from; index < from + SIZE * 0.25; index += 1) frame[index] = 40;
  return frame;
}

function mix(a: Float32Array, b: Float32Array, t: number) {
  return a.map((value, index) => value * (1 - t) + b[index]! * t);
}

describe('transition frame metric (058, FR-027)', () => {
  const start = page('left');
  const end = page('right');

  it('passes a crossfade: every frame lies between the two screens', () => {
    const frames = [0.2, 0.4, 0.6, 0.8, 1].map((t, index) => ({
      at: (index + 1) * 40,
      luma: mix(start, end, t)
    }));
    const result = analyzeTransition({ start, end, frames });
    expect(result.dipped).toBe(false);
    expect(result.worstExcess).toBeLessThan(1.1);
    expect(result.settledMs).toBe(200);
  });

  it('does not call a crossfade a pop', () => {
    const frames = Array.from({ length: 12 }, (_, index) => ({
      at: (index + 1) * 16,
      luma: mix(start, end, (index + 1) / 12)
    }));
    const result = analyzeTransition({ start, end, frames });
    expect(result.popped).toBe(false);
    expect(result.popShare).toBeLessThan(0.2);
  });

  it('fails content that appears at once, though no frame is blank', () => {
    const frames = [
      ...Array.from({ length: 6 }, (_, index) => ({ at: (index + 1) * 16, luma: start })),
      { at: 112, luma: end },
      ...Array.from({ length: 6 }, (_, index) => ({ at: 128 + index * 16, luma: end }))
    ];
    const result = analyzeTransition({ start, end, frames });
    expect(result.dipped).toBe(false);
    expect(result.popped).toBe(true);
    expect(result.largestStepAt).toBe(112);
  });

  it('measures how long the canvas stood bare, not counting gaps in the recording', () => {
    const background = solid(100);
    const frames = [
      { at: 16, luma: mix(start, background, 0.5) },
      { at: 32, luma: background },
      { at: 48, luma: background },
      // The recorder stalls here; the stall is not time the screen was seen empty.
      { at: 400, luma: mix(background, end, 0.6) },
      { at: 416, luma: end }
    ];
    const result = analyzeTransition({ start, end, frames, background });
    expect(result.flashed).toBe(true);
    expect(result.bareMs).toBeGreaterThanOrEqual(32);
    expect(result.bareMs).toBeLessThan(120);
  });

  it('fails a blank frame in the middle', () => {
    const frames = [
      { at: 40, luma: mix(start, end, 0.3) },
      { at: 80, luma: solid(250) },
      { at: 120, luma: end }
    ];
    const result = analyzeTransition({ start, end, frames });
    expect(result.dipped).toBe(true);
    expect(result.worstAt).toBe(80);
  });

  it('fails a flash between two screens that look alike', () => {
    const similar = page('left');
    const frames = [
      { at: 40, luma: solid(255) },
      { at: 80, luma: similar }
    ];
    expect(analyzeTransition({ start: similar, end: similar, frames }).dipped).toBe(true);
  });

  it('fails a frame that shows the bare background between two screens', () => {
    const background = solid(100);
    const frames = [
      { at: 40, luma: mix(start, background, 0.8) },
      { at: 120, luma: end }
    ];
    const result = analyzeTransition({ start, end, frames, background });
    expect(result.flashed).toBe(true);
    expect(result.dipped).toBe(true);
    expect(result.worstAt).toBe(40);
  });

  it('passes a crossfade that never shows more background than its ends', () => {
    const background = solid(100);
    const frames = [0.25, 0.5, 0.75, 1].map((t, index) => ({
      at: (index + 1) * 40,
      luma: mix(start, end, t)
    }));
    expect(analyzeTransition({ start, end, frames, background }).flashed).toBe(false);
  });

  it('reports a late settle when the old screen lingers on top', () => {
    const frames = [
      { at: 40, luma: mix(start, end, 0.5) },
      { at: 200, luma: mix(start, end, 0.5) },
      { at: 600, luma: mix(start, end, 0.5) },
      { at: 640, luma: end }
    ];
    expect(analyzeTransition({ start, end, frames }).settledMs).toBe(640);
  });

  it('crops and converts RGBA to luma', () => {
    const width = 4;
    const rgba = new Uint8ClampedArray(width * 2 * 4).fill(255);
    const luma = lumaOf(rgba, width, { x: 0, y: 0, width: 4, height: 2 }, 1);
    expect(luma).toHaveLength(8);
    expect(distance(luma, solid(255).slice(0, 8))).toBeLessThan(0.01);
  });
});
