import { open } from 'node:fs/promises';
import path from 'node:path';

export type HdrTransfer = 'pq' | 'hlg';
export type HdrPrimaries = 'bt709' | 'bt2020' | 'smpte432';
type Rgb = readonly [number, number, number];
type Matrix = readonly [Rgb, Rgb, Rgb];

// BT.2100 transfer functions. Units after conversion are100 cd/m², as required
// by FFmpeg's float tone mapper. No input pixels or source metadata are persisted.
export function pqToLinear(value: number): number {
  const p = Math.pow(Math.max(0, Math.min(1, value)), 32 / 2523);
  return (
    100 * Math.pow(Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p), 16384 / 2610)
  );
}
export function hlgToScene(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  const a = 0.17883277,
    b = 1 - 4 * a,
    c = 0.5 - a * Math.log(4 * a);
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
}
export function linearToBt709(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v < 0.018 ? 4.5 * v : 1.099 * Math.pow(v, 0.45) - 0.099;
}
function multiply(matrix: Matrix, value: Rgb): Rgb {
  return matrix.map(row => row.reduce((sum, v, i) => sum + v * value[i]!, 0)) as unknown as Rgb;
}
function inverse(m: Matrix): Matrix {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d]
  ].map(row => row.map(v => v / det)) as unknown as Matrix;
}
function rgbToXyz(primaries: HdrPrimaries): Matrix {
  const xy: readonly Rgb[] =
    primaries === 'bt2020'
      ? [
          [0.708, 0.292, 0],
          [0.17, 0.797, 0],
          [0.131, 0.046, 0]
        ]
      : primaries === 'smpte432'
        ? [
            [0.68, 0.32, 0],
            [0.265, 0.69, 0],
            [0.15, 0.06, 0]
          ]
        : [
            [0.64, 0.33, 0],
            [0.3, 0.6, 0],
            [0.15, 0.06, 0]
          ];
  const columns = xy.map(([x, y]) => [x / y, 1, (1 - x - y) / y] as const);
  const base = [0, 1, 2].map(r => columns.map(column => column[r]!)) as unknown as Matrix;
  const scale = multiply(inverse(base), [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329]);
  return base.map(row => row.map((v, i) => v * scale[i]!)) as unknown as Matrix;
}
const TO_709 = inverse(rgbToXyz('bt709'));
const PRIMARY_MATRICES: Record<HdrPrimaries, Matrix> = {
  bt709: rgbToXyz('bt709'),
  bt2020: rgbToXyz('bt2020'),
  smpte432: rgbToXyz('smpte432')
};

/** Standard reference HLG display:1000 nits, system gamma1.2. */
export function hdrToLinear709(rgb: Rgb, transfer: HdrTransfer, primaries: HdrPrimaries): Rgb {
  let linear: Rgb;
  if (transfer === 'pq') linear = rgb.map(pqToLinear) as unknown as Rgb;
  else {
    const scene = rgb.map(hlgToScene) as unknown as Rgb;
    const y = multiply(PRIMARY_MATRICES[primaries], scene)[1];
    const gain = 10 * Math.pow(Math.max(0, y), 0.2);
    linear = scene.map(v => v * gain) as unknown as Rgb;
  }
  return multiply(TO_709, multiply(PRIMARY_MATRICES[primaries], linear));
}

/**
 * Portable float LUTs feed linear BT.709 to the shipped tone mapper, then apply
 * BT.709's output transfer. Relative fixed names avoid Windows/path escaping
 * in filter graphs.65³ samples retain HDR precision; only one plane is buffered.
 */
export async function writeHdrLuts(
  directory: string,
  transfer: HdrTransfer,
  primaries: HdrPrimaries,
  signal: AbortSignal
): Promise<void> {
  const cube = await open(path.join(directory, 'hevc-linear.cube'), 'wx', 0o600);
  try {
    await cube.write('LUT_3D_SIZE 65\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n');
    for (let b = 0; b < 65; b++) {
      signal.throwIfAborted();
      const lines: string[] = [];
      for (let g = 0; g < 65; g++)
        for (let r = 0; r < 65; r++)
          lines.push(
            hdrToLinear709([r / 64, g / 64, b / 64], transfer, primaries)
              .map(v => v.toPrecision(10))
              .join(' ')
          );
      await cube.write(lines.join('\n') + '\n');
    }
  } finally {
    await cube.close();
  }
  const output = await open(path.join(directory, 'hevc-bt709.cube'), 'wx', 0o600);
  try {
    await output.write('LUT_1D_SIZE 4096\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n');
    const values = Array.from({ length: 4096 }, (_, i) => {
      const v = linearToBt709(i / 4095).toPrecision(10);
      return `${v} ${v} ${v}`;
    });
    await output.write(values.join('\n') + '\n');
  } finally {
    await output.close();
  }
}

export function hdrFilter(
  transfer: HdrTransfer,
  _primaries: HdrPrimaries,
  peakNits: number,
  inputRange: 'tv' | 'pc',
  matrix: 'bt2020' | 'bt709' | 'smpte170m' = 'bt2020'
): string[] {
  const peak = transfer === 'hlg' ? 10 : Math.max(1, Math.min(100, peakNits / 100));
  return [
    `scale=in_color_matrix=${matrix}:in_range=${inputRange}:out_range=pc`,
    'format=gbrpf32le',
    'lut3d=file=hevc-linear.cube:interp=tetrahedral',
    'setparams=range=full:color_primaries=bt709:color_trc=linear:colorspace=bt709',
    `tonemap=tonemap=mobius:param=0.3:desat=2:peak=${peak}`,
    'lut1d=file=hevc-bt709.cube:interp=linear',
    'setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=gbr',
    'scale=in_range=pc:out_color_matrix=bt709:out_range=tv',
    'format=yuv420p'
  ];
}
