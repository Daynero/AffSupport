import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runGate } from '../scripts/lib/gate.mjs';
import { removeTemporaryDirectory } from './support/temp-dir';

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it('times out the owned wrapper and its worker while leaving an unrelated process alive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-gate-tree-'));
  const parent = path.join(directory, 'parent.cjs'),
    worker = path.join(directory, 'worker.cjs');
  const marker = path.join(directory, 'owned.json');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  });
  let owned: { parent: number; worker: number } | undefined;
  try {
    await writeFile(worker, 'setInterval(() => {}, 1000);');
    await writeFile(
      parent,
      `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,[process.argv[2]],{stdio:'inherit'});
child.once('spawn',()=>require('node:fs').writeFileSync(process.argv[3],JSON.stringify({parent:process.pid,worker:child.pid})));
setInterval(()=>{},1000);`
    );
    const result = await runGate({
      id: 'tree-timeout',
      command: process.execPath,
      args: [parent, worker, marker],
      timeoutMs: 2500
    });
    owned = JSON.parse(await readFile(marker, 'utf8')) as typeof owned;
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(result.subject).toContain('exceeded its 2500 ms budget');
    expect(owned).toBeDefined();
    await expect
      .poll(() => alive(owned!.parent) || alive(owned!.worker), { timeout: 2000 })
      .toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
  } finally {
    unrelated.kill('SIGKILL');
    if (!owned) {
      try {
        owned = JSON.parse(await readFile(marker, 'utf8')) as typeof owned;
      } catch {
        /* Spawn failed before readiness. */
      }
    }
    for (const pid of owned ? [owned.parent, owned.worker] : []) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already reaped. Only our recorded fixture PIDs. */
      }
    }
    await removeTemporaryDirectory(directory);
  }
}, 15_000);
