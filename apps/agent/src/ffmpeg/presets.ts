import type { PresetId } from '@video-compressor/shared';

export interface PresetDefinition { id: PresetId; crf: string; ffPreset: string; scaleLimit: number | null; fpsCap: number | null; audioCopyFirst: boolean; audio: string[] }
// Manual Quality controls. Ignored by Balanced/Ultra Small, which keep their fixed definitions.
export interface EncodeOptions { frameRate?: number; crf?: number; videoBitrateKbps?: number | null; keepResolution?: boolean; resolutionLimit?: number }
// Longest side used when the Quality "keep resolution" option is off and no custom value is given.
export const QUALITY_DOWNSCALE_LIMIT = 1920;
const fit = (limit: number) => `scale='if(gte(iw,ih),min(${limit},iw),-2)':'if(gte(iw,ih),-2,min(${limit},ih))'`;
export const PRESETS: Record<PresetId, PresetDefinition> = {
  quality: { id: 'quality', crf: '24', ffPreset: 'slow', scaleLimit: null, fpsCap: null, audioCopyFirst: true, audio: ['-c:a', 'copy'] },
  balanced: { id: 'balanced', crf: '26', ffPreset: 'slow', scaleLimit: 720, fpsCap: 24, audioCopyFirst: false, audio: ['-c:a', 'aac', '-b:a', '96k'] },
  'ultra-small': { id: 'ultra-small', crf: '30', ffPreset: 'veryslow', scaleLimit: 550, fpsCap: 20, audioCopyFirst: false, audio: ['-c:a', 'aac', '-ac', '1', '-b:a', '48k'] }
};
// Build the video codec/filter arguments. The manual controls only apply to Quality; the other
// presets stay fixed. Rate control is a target bitrate when one is set, otherwise CRF. The output
// is never upsampled and a higher frame rate never raises a preset above its own cap.
export function videoArgs(presetId: PresetId, options: EncodeOptions = {}): string[] {
  const preset = PRESETS[presetId];
  const advanced = presetId === 'quality';
  const args = ['-c:v', 'libx264', '-preset', preset.ffPreset];
  const bitrate = advanced && options.videoBitrateKbps ? options.videoBitrateKbps : null;
  if (bitrate) args.push('-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`);
  else args.push('-crf', String(advanced && options.crf != null ? options.crf : preset.crf));
  const filters: string[] = [];
  const scaleLimit = advanced ? (options.keepResolution === false ? (options.resolutionLimit ?? QUALITY_DOWNSCALE_LIMIT) : null) : preset.scaleLimit;
  if (scaleLimit) filters.push(fit(scaleLimit));
  const fpsCap = advanced ? (options.frameRate ?? null) : preset.fpsCap;
  if (fpsCap != null) filters.push(`fps='min(${fpsCap},source_fps)'`);
  if (filters.length) args.push('-vf', filters.join(','));
  return args;
}
export function buildFfmpegArgs(input: string, output: string, presetId: PresetId, options: EncodeOptions = {}, forceAac = false): string[] {
  const preset = PRESETS[presetId];
  const audio = forceAac ? ['-c:a', 'aac', '-b:a', '96k'] : preset.audio;
  return ['-hide_banner', '-nostdin', '-n', '-i', input, ...videoArgs(presetId, options), ...audio, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output];
}
export function buildEstimateArgs(input: string, output: string, presetId: PresetId, start: number, duration: number, options: EncodeOptions = {}): string[] { return ['-hide_banner','-nostdin','-y','-ss',start.toFixed(3),'-i',input,'-t',duration.toFixed(3),...videoArgs(presetId, options),'-an','-f','h264',output]; }
