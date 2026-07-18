import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';

export async function nextOutputPath(inputPath: string, outputFolder?: string, reserved: Iterable<string> = []): Promise<string> {
  const parsed = path.parse(inputPath);
  const reservedPaths = new Set([...reserved].map(value => path.resolve(value)));
  let n = 1;
  while (true) {
    const suffix = n === 1 ? '_compressed' : `_compressed_${n}`;
    const candidate = path.join(outputFolder ?? parsed.dir, `${parsed.name}${suffix}.mp4`);
    if (path.resolve(candidate) === path.resolve(inputPath)) throw new Error('Output path cannot equal input path.');
    if (reservedPaths.has(path.resolve(candidate))) { n += 1; continue; }
    try { await access(candidate, constants.F_OK); n += 1; } catch { return candidate; }
  }
}
export function appearsCompressed(filePath: string): boolean { return /_compressed(?:_\d+)?$/i.test(path.parse(filePath).name); }

export async function fileSize(filePath: string): Promise<number> { return (await stat(filePath)).size; }
