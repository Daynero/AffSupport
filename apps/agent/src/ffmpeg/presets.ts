import type { PresetId } from '@video-compressor/shared';

export interface PresetDefinition { id: PresetId; crf: string; ffPreset: string; scaleLimit: number | null; fpsCap: number | null; audioCopyFirst: boolean; audio: string[] }
const fit = (limit: number) => `scale='if(gte(iw,ih),min(${limit},iw),-2)':'if(gte(iw,ih),-2,min(${limit},ih))'`;
export const PRESETS: Record<PresetId, PresetDefinition> = {
  quality: { id: 'quality', crf: '24', ffPreset: 'slow', scaleLimit: null, fpsCap: null, audioCopyFirst: true, audio: ['-c:a', 'copy'] },
  balanced: { id: 'balanced', crf: '26', ffPreset: 'slow', scaleLimit: 720, fpsCap: 24, audioCopyFirst: false, audio: ['-c:a', 'aac', '-b:a', '96k'] },
  'ultra-small': { id: 'ultra-small', crf: '30', ffPreset: 'veryslow', scaleLimit: 550, fpsCap: 20, audioCopyFirst: false, audio: ['-c:a', 'aac', '-ac', '1', '-b:a', '48k'] }
};
// Build the video filter/codec arguments. The output frame rate is capped to the smallest of the
// preset's own limit, the user's chosen frameRate, and the source rate — so a higher slider value
// never raises a preset above its intended ceiling, and Quality (no preset cap) follows the slider.
export function videoArgs(preset: PresetDefinition, frameRate?: number): string[] {
  const args = ['-c:v', 'libx264', '-crf', preset.crf, '-preset', preset.ffPreset];
  const filters: string[] = [];
  if (preset.scaleLimit) filters.push(fit(preset.scaleLimit));
  const caps = [preset.fpsCap, frameRate].filter((value): value is number => typeof value === 'number');
  if (caps.length) filters.push(`fps='min(${Math.min(...caps)},source_fps)'`);
  if (filters.length) args.push('-vf', filters.join(','));
  return args;
}
export function buildFfmpegArgs(input: string, output: string, presetId: PresetId, frameRate?: number, forceAac = false): string[] {
  const preset = PRESETS[presetId];
  const audio = forceAac ? ['-c:a', 'aac', '-b:a', '96k'] : preset.audio;
  return ['-hide_banner', '-nostdin', '-n', '-i', input, ...videoArgs(preset, frameRate), ...audio, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output];
}
export function buildEstimateArgs(input: string, output: string, presetId: PresetId, start: number, duration: number, frameRate?: number): string[] { return ['-hide_banner','-nostdin','-y','-ss',start.toFixed(3),'-i',input,'-t',duration.toFixed(3),...videoArgs(PRESETS[presetId], frameRate),'-an','-f','h264',output]; }
