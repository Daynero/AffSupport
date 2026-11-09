import { readFile, stat } from 'node:fs/promises';
import type { ReleasePlatform } from '@video-compressor/shared';

/** Installed package metadata is independent of the architecture Node executes. */
export async function readPackageTarget(config: {
  installedReleasePath?: string | null;
  buildId: string;
}): Promise<ReleasePlatform | 'unknown'> {
  if (!config.installedReleasePath) return 'unknown';
  try {
    const info = await stat(config.installedReleasePath);
    if (!info.isFile() || info.size > 16384) return 'unknown';
    const value: unknown = JSON.parse(await readFile(config.installedReleasePath, 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      !('buildId' in value) ||
      value.buildId !== config.buildId ||
      !('target' in value)
    )
      return 'unknown';
    return value.target === 'macos-arm64' ||
      value.target === 'macos-x64' ||
      value.target === 'windows-x64'
      ? value.target
      : 'unknown';
  } catch {
    // Missing, legacy or unreadable metadata proves no target; never infer it from the CPU.
    return 'unknown';
  }
}
