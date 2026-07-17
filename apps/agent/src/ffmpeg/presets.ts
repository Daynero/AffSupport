import type { PresetId } from '@video-compressor/shared';

export interface PresetDefinition { id: PresetId; video: string[]; audioCopyFirst: boolean; audio: string[] }
const fit = (limit: number) => `scale='if(gte(iw,ih),min(${limit},iw),-2)':'if(gte(iw,ih),-2,min(${limit},ih))'`;
export const PRESETS: Record<PresetId, PresetDefinition> = {
  quality: { id: 'quality', video: ['-c:v', 'libx264', '-crf', '24', '-preset', 'slow'], audioCopyFirst: true, audio: ['-c:a', 'copy'] },
  balanced: { id: 'balanced', video: ['-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-vf', `${fit(720)},fps='min(24,source_fps)'`], audioCopyFirst: false, audio: ['-c:a', 'aac', '-b:a', '96k'] },
  'ultra-small': { id: 'ultra-small', video: ['-c:v', 'libx264', '-crf', '30', '-preset', 'veryslow', '-vf', `${fit(550)},fps='min(20,source_fps)'`], audioCopyFirst: false, audio: ['-c:a', 'aac', '-ac', '1', '-b:a', '48k'] }
};
export function buildFfmpegArgs(input: string, output: string, presetId: PresetId, forceAac = false): string[] {
  const preset = PRESETS[presetId];
  const audio = forceAac ? ['-c:a', 'aac', '-b:a', '96k'] : preset.audio;
  return ['-hide_banner', '-nostdin', '-n', '-i', input, ...preset.video, ...audio, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output];
}
export function buildEstimateArgs(input: string, output: string, presetId: PresetId, start: number, duration: number): string[] { const preset=PRESETS[presetId]; return ['-hide_banner','-nostdin','-y','-ss',start.toFixed(3),'-i',input,'-t',duration.toFixed(3),...preset.video,'-an','-f','h264',output]; }
