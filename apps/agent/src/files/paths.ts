import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';

export async function nextOutputPath(
  inputPath: string,
  outputFolder?: string,
  reserved: Iterable<string> = [],
  embedded = false,
  customSuffix?: string | null
): Promise<string> {
  const parsed = path.parse(inputPath);
  const reservedPaths = new Set([...reserved].map(value => path.resolve(value)));
  let n = 1;
  while (true) {
    const baseSuffix = customSuffix ?? (embedded ? '_embedded_compressed' : '_compressed');
    const suffix = n === 1 ? baseSuffix : `${baseSuffix}_${n}`;
    const candidate = path.join(outputFolder ?? parsed.dir, `${parsed.name}${suffix}.mp4`);
    if (path.resolve(candidate) === path.resolve(inputPath))
      throw new Error('Output path cannot equal input path.');
    if (reservedPaths.has(path.resolve(candidate))) {
      n += 1;
      continue;
    }
    try {
      await access(candidate, constants.F_OK);
      n += 1;
    } catch {
      return candidate;
    }
  }
}

export type ConvertedImageExtension = '.png' | '.jpg' | '.webp';

export async function nextConvertedImagePath(
  inputPath: string,
  extension: ConvertedImageExtension,
  reserved: Iterable<string> = []
): Promise<string> {
  const parsed = path.parse(inputPath);
  const resolvedInput = path.resolve(inputPath);
  const reservedPaths = new Set([...reserved].map(value => path.resolve(value)));
  let n = 1;
  while (true) {
    const suffix = n === 1 ? '' : `_${n}`;
    const candidate = path.join(parsed.dir, `${parsed.name}${suffix}${extension}`);
    const resolvedCandidate = path.resolve(candidate);
    if (resolvedCandidate === resolvedInput || reservedPaths.has(resolvedCandidate)) {
      n += 1;
      continue;
    }
    try {
      await access(candidate, constants.F_OK);
      n += 1;
    } catch {
      return candidate;
    }
  }
}

export function appearsCompressed(filePath: string): boolean {
  return /_(?:embedded_)?compressed(?:_\d+)?$/i.test(path.parse(filePath).name);
}

export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}
