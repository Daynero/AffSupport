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
