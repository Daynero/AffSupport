import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applicationSupportRoot } from '../files/support-dir.js';

export interface CommandResult {
  code: number | null;
  stderr: string;
}

/** Runs a system command without a shell and collects its exit code/stderr. */
export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.once('error', error => {
      stderr += error.message;
      resolve({ code: 1, stderr });
    });
    child.once('close', code => resolve({ code, stderr }));
  });
}

/** Root directory that holds all Landing Optimizer working copies. */
export function landingWorkspacesRoot(): string {
  return (
    process.env.AGENT_LANDING_WORKSPACE ?? path.join(applicationSupportRoot(), 'LandingWorkspaces')
  );
}

/** Creates a fresh, isolated working directory for one landing job. */
export async function createWorkspace(): Promise<string> {
  const root = landingWorkspacesRoot();
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'landing-'));
}

export async function removeWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

/** Extracts a ZIP archive into a destination directory (macOS `ditto`). */
export async function unzip(zipPath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const result = await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, destination]);
  if (result.code !== 0) {
    throw new Error(`Could not unpack the archive: ${result.stderr.trim() || 'unknown error'}`);
  }
}

/** Copies a directory tree into a destination (originals are never touched). */
export async function copyDir(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, dereference: false, force: true });
}

/** Returns a path that does not yet exist, appending ` 2`, ` 3`, … if needed. */
export async function uniquePath(candidate: string): Promise<string> {
  const parsed = path.parse(candidate);
  let attempt = candidate;
  let n = 2;
  while (await exists(attempt)) {
    attempt = path.join(parsed.dir, `${parsed.name} ${n}${parsed.ext}`);
    n += 1;
  }
  return attempt;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Where results land when the source was uploaded (no original on disk). */
export function uploadedOutputDir(): string {
  return path.join(os.homedir(), 'Downloads', 'Wishly Landings');
}

/**
 * Produces the final optimized folder next to (or under) the destination
 * directory, named `<name>-optimized`, without clobbering existing results.
 */
export async function writeFolderOutput(
  processedRoot: string,
  destinationDir: string,
  name: string
): Promise<string> {
  await mkdir(destinationDir, { recursive: true });
  const output = await uniquePath(path.join(destinationDir, `${name}-optimized`));
  await copyDir(processedRoot, output);
  return output;
}

/**
 * Produces `<name>-optimized.zip`; the archive contains a single top-level
 * `<name>-optimized/` folder so the landing structure is preserved.
 */
export async function writeZipOutput(
  processedRoot: string,
  destinationDir: string,
  name: string,
  workspace: string
): Promise<string> {
  await mkdir(destinationDir, { recursive: true });
  const staging = path.join(workspace, 'archive', `${name}-optimized`);
  await copyDir(processedRoot, staging);
  const output = await uniquePath(path.join(destinationDir, `${name}-optimized.zip`));
  const result = await runCommand('/usr/bin/ditto', ['-c', '-k', '--keepParent', staging, output]);
  await rm(path.dirname(staging), { recursive: true, force: true }).catch(() => {});
  if (result.code !== 0) {
    throw new Error(`Could not create the archive: ${result.stderr.trim() || 'unknown error'}`);
  }
  return output;
}

/**
 * Sanitizes a browser-supplied relative path so an upload can never escape the
 * working directory: separators are normalized and any `.`/`..`/root segments
 * are dropped.
 */
export function sanitizeRelPath(relPath: string): string | null {
  const segments = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.' && segment !== '..');
  return segments.length ? segments.join('/') : null;
}

/**
 * Turns a source file/folder name into a clean landing name: drops a trailing
 * archive extension, strips path separators, and trims noise.
 */
export function landingNameFromSource(sourceName: string): string {
  const base = path.basename(sourceName).replace(/\.zip$/i, '');
  const cleaned = base.replace(/[\\/]+/g, '-').trim();
  return cleaned || 'landing';
}
