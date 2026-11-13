// Synthetic inputs only. Generation needs libx265; product/tests only decode HEVC.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
const cwd = fileURLToPath(new URL('.', import.meta.url));
const encode = (name, input, extra = []) => {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      input,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-t',
      '2',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'pools=1:frame-threads=1:log-level=error',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p10le',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-tag:v',
      'hvc1',
      ...extra,
      '-bsf:v',
      name === 'pq10' || name === 'hlg10'
        ? `hevc_metadata=colour_primaries=9:transfer_characteristics=${name === 'pq10' ? 16 : 18}:matrix_coefficients=9`
        : 'hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1',
      `${name}.mp4`
    ],
    { cwd, stdio: 'inherit' }
  );
  const file = readFileSync(new URL(`${name}.mp4`, import.meta.url));
  process.stdout.write(
    `${name}.mp4 ${file.length} ${createHash('sha256').update(file).digest('hex')}\n`
  );
};
encode('sdr10', 'testsrc2=size=160x96:rate=30:duration=2', [
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709'
]);
// Four neutral, limited-range 10-bit patches: black, PQ100nit / HLG203nit,
// PQ1000nit / HLG1000nit, white. Neutral YUV avoids an RGB transfer in the generator.
for (const [name, mid, high, transfer] of [
  ['pq10', 509, 723, 'smpte2084'],
  ['hlg10', 721, 940, 'arib-std-b67']
])
  encode(
    name,
    `nullsrc=size=160x96:rate=30:duration=2,format=yuv420p10le,geq=lum='if(lt(X,W/4),64,if(lt(X,W/2),${mid},if(lt(X,3*W/4),${high},940)))':cb=512:cr=512`,
    [
      '-color_range',
      'tv',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      transfer,
      '-colorspace',
      'bt2020nc'
    ]
  );
encode('vfr10', 'testsrc2=size=160x96:rate=30:duration=2', [
  '-vf',
  "select='if(lt(t,1),1,not(mod(n,2)))'",
  '-fps_mode',
  'vfr',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709'
]);
