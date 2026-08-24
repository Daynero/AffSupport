import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The machine probe must not be able to agree with the code it is checking.
 *
 * A14 is the reason this file exists: the best stop test in the suite today asserts on
 * Node's report of what Node did, so a termination that escalated wrongly, or a grandchild
 * that outlived its parent, would leave it green. The probe answers the same question by
 * asking the operating system — and that only holds while the probe shares no code with
 * the thing under test.
 *
 * Doubled deliberately. `eslint.config.mjs` carries the same restriction, and this scan
 * carries it again, because a lint rule is only enforced where lint is run and the whole
 * point of a structural guard is that it fails in the suite that gates the release.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'tests/support/machine-probe.ts');

async function probeSource(): Promise<string> {
  return readFile(PROBE, 'utf8');
}

/** Every module specifier the probe imports, static or dynamic. */
function importedSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return found;
}

describe('machine probe independence', () => {
  it('imports nothing from the platform or power modules it exists to check', async () => {
    const offenders = importedSpecifiers(await probeSource()).filter(specifier =>
      /(^|\/)apps\/agent\/src\/(platform|power)\//.test(specifier)
    );

    expect(offenders).toEqual([]);
  });

  it('imports nothing from the application at all', async () => {
    // Wider than the rule above on purpose. The queue, the compressor routes and the
    // shared types are all equally capable of carrying the app's opinion of what is
    // running into an assertion that is supposed to be checking it.
    const offenders = importedSpecifiers(await probeSource()).filter(specifier =>
      /(^|\/)(apps|packages)\//.test(specifier)
    );

    expect(offenders).toEqual([]);
  });

  it('reads the process table with different flags from production', async () => {
    const probe = await probeSource();
    const production = await readFile(
      path.join(ROOT, 'apps/agent/src/platform/platform.ts'),
      'utf8'
    );

    // Not cosmetic. If the probe issued the identical query, a bug in how that query is
    // built — the wrong flag, a filtered table, a truncated buffer — would be present in
    // both, and the comparison would confirm nothing.
    expect(production).toContain("'-axo', 'pid=,ppid='");
    expect(probe).not.toContain("'-axo', 'pid=,ppid='");
    expect(probe).toContain("'-eo', 'pid=,ppid=,lstart=,cputime=,comm='");
  });

  it('establishes liveness by syscall rather than by parsing', async () => {
    const probe = await probeSource();

    // `process.kill(pid, 0)` performs the existence check and delivers nothing. It cannot
    // be fooled by a stale table or a failed parse, and it appears nowhere in production —
    // there is no kill(pid,0), no pgrep, no pidof in the application.
    expect(probe).toMatch(/process\.kill\(pid,\s*0\)/);
  });

  it('never subtracts the machine-wide idle baseline from Soty’s share', async () => {
    const probe = await probeSource();

    // Recorded as a diagnostic, never applied. Subtracting runner noise is exactly how a
    // leaked process gets hidden behind it: the leak raises the machine's load, the
    // subtraction removes the rise, and the assertion passes.
    const share = probe.slice(probe.indexOf('sotySharePercent ='));
    expect(share.slice(0, 200)).not.toContain('machineIdle');
  });

  it('reports a suspended survivor as its own named failure', async () => {
    const probe = await probeSource();

    // A suspended orphan is in the table, answers kill(pid,0) and consumes nothing, so
    // every other check here reports it as a clean stop. Conflating it with "left running"
    // would describe the wrong bug to whoever has to fix it.
    expect(probe).toContain("'left suspended'");
    expect(probe).toContain("'left running'");
  });
});
