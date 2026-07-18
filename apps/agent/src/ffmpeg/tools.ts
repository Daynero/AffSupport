import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runtime/bin');
export const ffmpegPath = process.env.FFMPEG_PATH ?? (process.env.PACKAGED_APP === '1' ? path.join(bundledRoot, 'ffmpeg') : 'ffmpeg');
export const ffprobePath = process.env.FFPROBE_PATH ?? (process.env.PACKAGED_APP === '1' ? path.join(bundledRoot, 'ffprobe') : 'ffprobe');

export async function commandExists(command: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, ['-version'], { shell: false, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  });
}

export interface MediaInfo { duration: number | null; width: number | null; height: number | null; frameRate: number | null; bitrate: number | null }
export async function probeMedia(inputPath: string): Promise<MediaInfo> {
  const empty: MediaInfo = { duration: null, width: null, height: null, frameRate: null, bitrate: null };
  return new Promise(resolve => {
    const child = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,bit_rate:format=duration,bit_rate', '-of', 'json', inputPath], { shell: false });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(empty));
    child.on('close', () => {
      try {
        const data = JSON.parse(out); const stream = data.streams?.[0] ?? {};
        const durationRaw = Number(data.format?.duration); const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
        const [num, den] = String(stream.avg_frame_rate ?? '').split('/').map(Number);
        const frameRate = Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0 ? Math.round((num / den) * 100) / 100 : null;
        const streamBitrate = Number(stream.bit_rate), formatBitrate = Number(data.format?.bit_rate);
        const bitrate = Number.isFinite(streamBitrate) && streamBitrate > 0 ? streamBitrate : Number.isFinite(formatBitrate) && formatBitrate > 0 ? formatBitrate : null;
        const width = Number(stream.width) > 0 ? Number(stream.width) : null, height = Number(stream.height) > 0 ? Number(stream.height) : null;
        resolve({ duration, width, height, frameRate, bitrate });
      } catch { resolve(empty); }
    });
  });
}

export async function probeDuration(inputPath: string): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath], { shell: false });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', code => {
      const value = Number.parseFloat(out.trim());
      resolve(code === 0 && Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}
