import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { encodeVideo } from '../apps/agent/src/ffmpeg/encoder.js';
import { commandExists, probeDuration } from '../apps/agent/src/ffmpeg/tools.js';

let temp = '';
afterAll(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });
const run = (command: string, args: string[]) => new Promise<number | null>((resolve, reject) => { const p = spawn(command, args, { shell: false }); p.on('error', reject); p.on('close', resolve); });
describe('real FFmpeg end to end', () => {
  it('compresses a Unicode path, preserves the original, and produces a probeable MP4', async () => {
    if (!await commandExists('ffmpeg') || !await commandExists('ffprobe')) return;
    temp = await mkdtemp(path.join(os.tmpdir(), 'відео test '));
    const input = path.join(temp, 'коротке відео.mov'), output = path.join(temp, 'коротке відео_compressed.mp4');
    expect(await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', input])).toBe(0);
    const before = createHash('sha256').update(await readFile(input)).digest('hex');
    const duration = await probeDuration(input); expect(duration).not.toBeNull();
    const operation = encodeVideo(input, output, duration, 'quality', false, () => {});
    expect((await operation.done).code).toBe(0);
    expect(await probeDuration(output)).toBeGreaterThan(0);
    expect(createHash('sha256').update(await readFile(input)).digest('hex')).toBe(before);
  }, 20_000);
  it('runs all presets, preserves vertical aspect ratio, and never increases FPS', async () => {
    if (!await commandExists('ffmpeg') || !await commandExists('ffprobe')) return;
    temp = await mkdtemp(path.join(os.tmpdir(), 'vertical presets ')); const input=path.join(temp,'vertical source.mp4');
    expect(await run('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=800x1200:rate=12','-t','0.6','-c:v','libx264','-an',input])).toBe(0);
    const before=createHash('sha256').update(await readFile(input)).digest('hex'),duration=await probeDuration(input);
    for(const preset of ['quality','balanced','ultra-small'] as const){const output=path.join(temp,`${preset}.mp4`);const op=encodeVideo(input,output,duration,preset,false,()=>{});expect((await op.done).code).toBe(0);const meta=await probeStream(output);expect(meta.height).toBeGreaterThan(meta.width);expect(meta.width/meta.height).toBeCloseTo(2/3,1);expect(meta.fps).toBeLessThanOrEqual(12.01);if(preset==='balanced')expect(Math.max(meta.width,meta.height)).toBe(720);if(preset==='ultra-small')expect(Math.max(meta.width,meta.height)).toBe(550)}
    expect(createHash('sha256').update(await readFile(input)).digest('hex')).toBe(before);
  },30_000);
});
async function probeStream(file:string){return new Promise<{width:number;height:number;fps:number}>((resolve,reject)=>{const p=spawn('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height,avg_frame_rate','-of','json',file],{shell:false});let out='';p.stdout.on('data',d=>out+=d);p.on('error',reject);p.on('close',code=>{if(code!==0)return reject(new Error('ffprobe failed'));const s=JSON.parse(out).streams[0],parts=String(s.avg_frame_rate).split('/').map(Number);resolve({width:s.width,height:s.height,fps:parts[0]/parts[1]})})})}
