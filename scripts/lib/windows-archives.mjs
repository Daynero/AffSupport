// Archive helpers for the Windows packaging scripts.
//
// Deliberately mirrors apps/agent/src/platform/platform.ts: bsdtar reads and
// writes zip natively and ships on both supported build hosts (/usr/bin/tar on
// macOS, tar.exe on Windows 10 1803+), which avoids PowerShell startup/policy
// issues that make Compress-Archive fragile. Kept as a separate .mjs module
// because build scripts cannot import the agent's TypeScript.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function tarExecutable() {
  return process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
}

/** Entry names inside a ZIP archive, used to validate layout before extracting. */
export async function listZipEntries(zipPath) {
  const { stdout } = await run(tarExecutable(), ['-tf', zipPath], {
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.split(/\r?\n/u).filter(Boolean);
}

/** Extracts a ZIP archive into an existing destination directory. */
export async function unzipArchive(zipPath, destination) {
  await run(tarExecutable(), ['-xf', zipPath, '-C', destination], {
    maxBuffer: 8 * 1024 * 1024
  });
}
