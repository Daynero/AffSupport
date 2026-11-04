import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  removeWorkspace,
  runCommand,
  sanitizeRelPath,
  sweepWorkspaces,
  uniquePath,
  unzip,
  writeFolderOutput,
  writeZipOutput
} from '../apps/agent/src/landing/workspace.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-workspace-output-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTemporaryDirectory(directory);
});

it('sweeps abandoned working copies while retaining unrelated folders', async () => {
  const root = path.join(directory, 'workspaces');
  vi.stubEnv('AGENT_LANDING_WORKSPACE', root);
  expect(await sweepWorkspaces()).toBe(0);
  const workspace = await createWorkspace();
  const keep = path.join(root, 'keep');
  await mkdir(keep);
  await writeFile(path.join(workspace, 'index.html'), 'temporary');
  expect(await sweepWorkspaces()).toBe(1);
  await expect(access(workspace)).rejects.toThrow();
  await expect(access(keep)).resolves.toBeUndefined();
  await removeWorkspace(workspace);
});

it('chooses the next free result name while preserving its extension and existing files', async () => {
  const candidate = path.join(directory, 'landing.zip');
  await writeFile(candidate, 'first');
  await writeFile(path.join(directory, 'landing 2.zip'), 'second');
  expect(await uniquePath(candidate)).toBe(path.join(directory, 'landing 3.zip'));
  expect(await readFile(candidate, 'utf8')).toBe('first');
  expect(await readFile(path.join(directory, 'landing 2.zip'), 'utf8')).toBe('second');
});

it('copies a completed landing beside an existing result without overwriting either source', async () => {
  const source = path.join(directory, 'source');
  const destination = path.join(directory, 'results');
  const existing = path.join(destination, 'campaign-optimized');
  await mkdir(source);
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(source, 'index.html'), 'new landing');
  await writeFile(path.join(existing, 'index.html'), 'previous landing');
  const output = await writeFolderOutput(source, destination, 'campaign');
  expect(output).toBe(path.join(destination, 'campaign-optimized 2'));
  expect(await readFile(path.join(output, 'index.html'), 'utf8')).toBe('new landing');
  expect(await readFile(path.join(source, 'index.html'), 'utf8')).toBe('new landing');
  expect(await readFile(path.join(existing, 'index.html'), 'utf8')).toBe('previous landing');
});

it('keeps bounded tool stderr and reports a missing executable as a failed command', async () => {
  const result = await runCommand(process.execPath, [
    '-e',
    'process.stderr.write("x".repeat(9000)); process.exitCode = 3;'
  ]);
  expect(result).toEqual({ code: 3, stderr: 'x'.repeat(8000) });
  const missing = await runCommand(path.join(directory, 'missing-tool'), []);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('ENOENT');
});

it('writes a usable single-folder ZIP and removes its temporary staging tree', async () => {
  const source = path.join(directory, 'source');
  const workspace = path.join(directory, 'workspace');
  await mkdir(source);
  await writeFile(path.join(source, 'index.html'), 'complete landing');
  const output = await writeZipOutput(
    source,
    path.join(directory, 'results'),
    'campaign',
    workspace
  );
  const extracted = path.join(directory, 'extracted');
  await unzip(output, extracted);
  expect(await readFile(path.join(extracted, 'campaign-optimized', 'index.html'), 'utf8')).toBe(
    'complete landing'
  );
  await expect(access(path.join(workspace, 'archive'))).rejects.toThrow();
  expect(await readFile(path.join(source, 'index.html'), 'utf8')).toBe('complete landing');
}, 20_000);

it('removes traversal and root segments from browser-relative upload names', () => {
  expect(sanitizeRelPath('/../images\\..\\./cover.png')).toBe('images/cover.png');
  expect(sanitizeRelPath('/../../.')).toBeNull();
});
