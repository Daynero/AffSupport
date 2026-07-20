import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const COMMON_SOURCE_FOLDERS = ['Downloads', 'Desktop', 'Movies', 'Documents'];

export async function findDroppedSource(
  fileName: string,
  expectedSize: number,
  expectedModifiedAt: number
): Promise<string | null> {
  if (process.platform !== 'darwin' || !Number.isFinite(expectedSize)) return null;

  const home = os.homedir();
  const common = COMMON_SOURCE_FOLDERS.map(folder => path.join(home, folder, fileName));
  for (const candidate of common) {
    if (await matchesFile(candidate, expectedSize, expectedModifiedAt)) return candidate;
  }

  const escapedName = fileName.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const candidates = await spotlight(
    home,
    `kMDItemFSName == "${escapedName}"c && kMDItemFSSize == ${Math.round(expectedSize)}`
  );
  for (const candidate of candidates) {
    if (await matchesFile(candidate, expectedSize, expectedModifiedAt)) return candidate;
  }
  return null;
}

async function matchesFile(
  candidate: string,
  expectedSize: number,
  expectedModifiedAt: number
): Promise<boolean> {
  try {
    const details = await stat(candidate);
    return (
      details.isFile() &&
      details.size === expectedSize &&
      (!Number.isFinite(expectedModifiedAt) ||
        Math.abs(details.mtimeMs - expectedModifiedAt) < 2000)
    );
  } catch {
    return false;
  }
}

function spotlight(root: string, query: string): Promise<string[]> {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/mdfind', ['-onlyin', root, query], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length < 64 * 1024) output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(output.split('\n').filter(Boolean));
    });
  });
}
