import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { execute } from '../scripts/lib/release/execute.mjs';
import { removeTemporaryDirectory } from './support/temp-dir.js';

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.skipIf(process.platform === 'win32').each([
  {
    title: 'supervisor deadline',
    supervisorTimeout: 10000,
    innerTimeout: 30000,
    expectedTimedOut: true
  },
  {
    title: 'inner own deadline',
    supervisorTimeout: 20000,
    innerTimeout: 3500,
    expectedTimedOut: false
  }
])(
  '[needs: POSIX release host] propagates $title through detached gate owners and never starts later gates',
  async ({ supervisorTimeout, innerTimeout, expectedTimedOut }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-managed-gates-'));
    const gateUrl = pathToFileURL(path.resolve('scripts/lib/gate.mjs')).href;
    const marker = path.join(root, 'owned-child.json');
    const innerReport = path.join(root, 'inner-results.json');
    const outerReport = path.join(root, 'outer-results.json');
    const innerLater = path.join(root, 'inner-later');
    const outerLater = path.join(root, 'outer-later');
    const middle = path.join(root, 'middle.mjs');
    const aggregator = path.join(root, 'aggregator.mjs');
    const leaf = `
      process.on('SIGTERM', () => {});
      setTimeout(() => process.exit(0), 15000);
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));
      setInterval(() => {}, 1000);
    `;
    const later = (file: string) => ({
      id: 'must-not-start',
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'started')`],
      timeoutMs: 30000
    });
    const innerGates = [
      {
        id: 'ignores-term',
        command: process.execPath,
        args: ['-e', leaf],
        timeoutMs: innerTimeout
      },
      later(innerLater)
    ];
    await writeFile(
      middle,
      `import { runPhase } from ${JSON.stringify(gateUrl)};
       import { writeFileSync } from 'node:fs';
       const results = await runPhase(${JSON.stringify(innerGates)}, { serial: true });
       writeFileSync(${JSON.stringify(innerReport)}, JSON.stringify(results));
       process.exitCode = results.every(result => result.ok) ? 0 : 1;`
    );
    const outerGates = [
      {
        id: 'nested-owner',
        command: process.execPath,
        args: [middle],
        timeoutMs: 30000
      },
      later(outerLater)
    ];
    await writeFile(
      aggregator,
      `import { runPhase } from ${JSON.stringify(gateUrl)};
       import { writeFileSync } from 'node:fs';
       const results = await runPhase(${JSON.stringify(outerGates)}, { serial: true });
       writeFileSync(${JSON.stringify(outerReport)}, JSON.stringify(results));
       process.exitCode = results.every(result => result.ok) ? 0 : 1;`
    );
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
        shell: false
      }
    );
    let ownedPid: number | undefined;
    try {
      const result = await execute([process.execPath, aggregator], {
        cwd: process.cwd(),
        managedTree: true,
        timeoutMs: supervisorTimeout,
        env: {
          SOTY_WEB_MANAGED_TREE: '1',
          SOTY_WEB_MANAGED_DEPTH: '0',
          SOTY_VERIFY_SERIAL: '1'
        }
      });
      expect(result).toMatchObject({
        ok: false,
        timedOut: expectedTimedOut,
        cleanupConfirmed: true
      });
      ownedPid = JSON.parse(await readFile(marker, 'utf8')).pid;
      expect(ownedPid).toBeGreaterThan(1);
      await expect.poll(() => alive(ownedPid!), { timeout: 2000 }).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
      for (const report of [innerReport, outerReport]) {
        const results = JSON.parse(await readFile(report, 'utf8'));
        expect(results).toHaveLength(2);
        expect(results[0].ok).toBe(false);
        expect(results[1]).toMatchObject({ ok: false, duration_ms: 0 });
        expect(results[1].subject).toContain('was not started');
      }
      await expect(access(innerLater)).rejects.toThrow();
      await expect(access(outerLater)).rejects.toThrow();
      expect(result.output.join('')).not.toContain('WEB_MANAGED_CLEANUP_UNCONFIRMED');
    } finally {
      unrelated.kill('SIGKILL');
      if (!ownedPid) {
        try {
          ownedPid = JSON.parse(await readFile(marker, 'utf8')).pid;
        } catch {
          /* no spawned leaf */
        }
      }
      if (ownedPid && alive(ownedPid)) {
        try {
          process.kill(-ownedPid, 'SIGKILL');
        } catch {
          /* only the recorded fixture group */
        }
      }
      await removeTemporaryDirectory(root);
    }
  },
  25000
);

function running(pid: number) {
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    // An orphaned zombie can keep a group identifier reserved on a container
    // init. It is not running; the cleanup sentinel still fences that case.
    return Boolean(state) && !state.startsWith('Z');
  } catch {
    return false;
  }
}

it.skipIf(process.platform === 'win32')(
  '[needs: POSIX release host] fails a zero-exit gate whose ignored-pipe descendant remains in its private group',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-zero-exit-gate-'));
    const gateUrl = pathToFileURL(path.resolve('scripts/lib/gate.mjs')).href;
    const marker = path.join(root, 'worker.json');
    const after = path.join(root, 'must-not-start');
    const report = path.join(root, 'result.json');
    const aggregator = path.join(root, 'aggregate.mjs');
    const worker = `
      process.on('SIGTERM', () => {});
      setTimeout(() => process.exit(0), 15000);
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));
      setInterval(() => {}, 1000);
    `;
    const leader = `
      require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});
      setTimeout(() => process.exit(2), 15000);
      setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(marker)})) process.exit(0); }, 10);
    `;
    const gates = [
      { id: 'zero-leader', command: process.execPath, args: ['-e', leader], timeoutMs: 10000 },
      {
        id: 'later',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(after)},'started')`],
        timeoutMs: 10000
      }
    ];
    await writeFile(
      aggregator,
      `
      import {runPhase} from ${JSON.stringify(gateUrl)};
      import {writeFileSync} from 'node:fs';
      const results=await runPhase(${JSON.stringify(gates)},{serial:true});
      writeFileSync(${JSON.stringify(report)},JSON.stringify(results));
      process.exitCode=results.every(result=>result.ok)?0:1;
    `
    );
    let ownedPid: number | undefined;
    try {
      const result = await execute([process.execPath, aggregator], {
        cwd: process.cwd(),
        managedTree: true,
        timeoutMs: 10000,
        env: { SOTY_WEB_MANAGED_TREE: '1', SOTY_WEB_MANAGED_DEPTH: '0', SOTY_VERIFY_SERIAL: '1' }
      });
      expect(result.ok).toBe(false);
      ownedPid = JSON.parse(await readFile(marker, 'utf8')).pid;
      await expect.poll(() => running(ownedPid!), { timeout: 2000 }).toBe(false);
      const results = JSON.parse(await readFile(report, 'utf8'));
      expect(results[0].ok).toBe(false);
      expect(results[0].lines.join(' ')).toContain('lingering_descendants');
      expect(results[1]).toMatchObject({ ok: false, duration_ms: 0 });
      await expect(access(after)).rejects.toThrow();
    } finally {
      if (!ownedPid) {
        try {
          ownedPid = JSON.parse(await readFile(marker, 'utf8')).pid;
        } catch {
          /* no fixture child */
        }
      }
      if (ownedPid && running(ownedPid)) {
        try {
          process.kill(ownedPid, 'SIGKILL');
        } catch {
          /* only the recorded fixture child */
        }
      }
      await removeTemporaryDirectory(root);
    }
  },
  14000
);

it.skipIf(process.platform === 'win32')(
  '[needs: POSIX release host] forwards a deepest split cleanup sentinel through two owners before either prints its final report',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-nested-cleanup-sentinel-'));
    const gateUrl = pathToFileURL(path.resolve('scripts/lib/gate.mjs')).href;
    const marker = path.join(root, 'leaf.json');
    const middle = path.join(root, 'middle.mjs');
    const outer = path.join(root, 'outer.mjs');
    const middleReport = path.join(root, 'middle-final-report');
    const outerReport = path.join(root, 'outer-final-report');
    const sentinel = 'WEB_MANAGED_CLEANUP_UNCONFIRMED';
    const leaf = `
      setTimeout(() => process.exit(2), 15000);
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));
      process.stderr.write(${JSON.stringify(sentinel.slice(0, 16))});
      setTimeout(() => {
        process.stderr.write(${JSON.stringify(sentinel.slice(16) + '\n')});
        process.exit(1);
      }, 50);
    `;
    await writeFile(
      middle,
      `import {runGate} from ${JSON.stringify(gateUrl)};
       import {writeFileSync} from 'node:fs';
       setTimeout(() => process.exit(2), 15000);
       await runGate({id:'leaf',command:process.execPath,args:['-e',${JSON.stringify(leaf)}],timeoutMs:30000});
       await new Promise(() => {});
       writeFileSync(${JSON.stringify(middleReport)},'rendered');`
    );
    await writeFile(
      outer,
      `import {runGate} from ${JSON.stringify(gateUrl)};
       import {writeFileSync} from 'node:fs';
       setTimeout(() => process.exit(2), 15000);
       await runGate({id:'middle',command:process.execPath,args:[${JSON.stringify(middle)}],timeoutMs:30000});
       await new Promise(() => {});
       writeFileSync(${JSON.stringify(outerReport)},'rendered');`
    );
    let ownedPid: number | undefined;
    try {
      const result = await execute([process.execPath, outer], {
        cwd: process.cwd(),
        managedTree: true,
        timeoutMs: 10000,
        env: {
          SOTY_WEB_MANAGED_TREE: '1',
          SOTY_WEB_MANAGED_DEPTH: '0',
          SOTY_VERIFY_SERIAL: '1'
        }
      });
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.output.join('')).toContain(sentinel);
      await expect(access(middleReport)).rejects.toThrow();
      await expect(access(outerReport)).rejects.toThrow();
      ownedPid = JSON.parse(await readFile(marker, 'utf8')).pid;
      await expect.poll(() => running(ownedPid!), { timeout: 2000 }).toBe(false);
    } finally {
      if (!ownedPid) {
        try {
          ownedPid = JSON.parse(await readFile(marker, 'utf8')).pid;
        } catch {
          /* Leaf never started. Both owners have independent 15s fuses. */
        }
      }
      if (ownedPid && running(ownedPid)) {
        try {
          process.kill(ownedPid, 'SIGKILL');
        } catch {
          /* Only this fixture's recorded child. */
        }
      }
      await removeTemporaryDirectory(root);
    }
  },
  25000
);
