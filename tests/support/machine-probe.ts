import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * What the machine is actually doing — asked independently of the app being tested.
 *
 * The current best stop test asserts on Node's report of what Node did (A14). If the
 * agent escalated a termination incorrectly, or left a grandchild behind, that test stays
 * green: it is reading the same opinion that produced the bug. This module exists to ask
 * the operating system instead.
 *
 * **What independence buys, precisely.** Independence of the *query* is neither achievable
 * nor valuable — the process table is the operating system's fact, not Soty's opinion.
 * What must be independent is the **code, the parsing, the tree walk and the pid inputs**.
 * So: different flags and different columns from `platform.ts`, a tree walk written here
 * rather than imported from `power/process-tree.ts`, and pids captured by the harness that
 * spawned the agent rather than read back from the agent's own bookkeeping.
 *
 * A lint restriction and `tests/machine-probe-independence.test.ts` both forbid importing
 * `apps/agent/src/platform/**` and `apps/agent/src/power/**` from here, because otherwise
 * the independence decays on the first convenient import.
 *
 * **Three layers of "nothing belonging to this job is running".**
 *
 * 1. `process.kill(pid, 0)` — a syscall. No shell, no parsing, and a mechanism that appears
 *    nowhere in production: there is no `kill(pid,0)`, no `pgrep` in the repository. This is
 *    authoritative over anything the table says.
 * 2. A `(pid, createdAt)` tuple, so a recycled pid cannot be mistaken for a survivor. A9
 *    records that the governor's only guard against recycling is a three-second recency
 *    window; this harness must not inherit that weakness.
 * 3. A suspension check on any survivor, Windows only. A suspended orphan is present in the
 *    table and alive to `kill(pid,0)`, and it is the failure mode spec 008 called the most
 *    consequential in its design. It is reported as **"left suspended"** — a distinct named
 *    failure from "left running", because they are different bugs.
 */

/** One process, as the operating system describes it. */
export interface ProcessObservation {
  pid: number;
  ppid: number;
  /** Epoch milliseconds. With `pid`, identifies a process across pid recycling. */
  createdAt: number;
  name: string;
  /** Cumulative CPU consumed since the process started. Differenced, never sampled as a rate. */
  cpuMillis: number;
  /** Windows only; `null` everywhere else, where suspension is SIGSTOP and shows in state. */
  suspended: boolean | null;
}

/** The identity of a process, stable against pid recycling. */
export interface ProcessHandle {
  pid: number;
  createdAt: number;
  name: string;
}

/** One observation of the machine, rooted at the agent the harness itself spawned. */
export interface MachineSample {
  at: number;
  /** The agent and every descendant of it. */
  tree: readonly ProcessObservation[];
  totalCapacityCores: number;
  /**
   * Soty's share of the whole machine's capacity across the interval since the previous
   * sample, as a percentage. Zero on the first sample, which has no interval to difference.
   */
  sotySharePercent: number;
  /**
   * How idle the machine as a whole was across the same interval. **Diagnostic only.**
   * Recorded and never subtracted from the share above: subtraction is exactly how a
   * leaked process gets hidden behind runner noise.
   */
  machineIdlePercent: number;
}

/** A process that outlived the stop that was supposed to end it. */
export interface Survivor {
  handle: ProcessHandle;
  /** Two different bugs, never conflated. */
  reason: 'left running' | 'left suspended';
}

/**
 * Is this pid alive right now?
 *
 * Signal 0 performs the existence and permission checks and delivers nothing. It cannot be
 * fooled by a stale table, and it does not depend on a parse succeeding.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else — alive for our purposes.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Every process on the machine, unfiltered.
 *
 * The whole table rather than a filtered query, on purpose: a process that has been
 * reparented away from the agent — the orphan case this feature exists to catch — is only
 * findable if it was read in the first place.
 */
export async function readProcessTable(): Promise<ProcessObservation[]> {
  return process.platform === 'win32' ? readWindowsTable() : readUnixTable();
}

async function readUnixTable(): Promise<ProcessObservation[]> {
  // `-eo` with `lstart`, `cputime` and `comm`. Production reads `-axo pid=,ppid=` and gets
  // CPU from a second, pid-filtered call; this is one call, four extra columns and a
  // different parse. `LC_ALL=C` is not cosmetic — `lstart` is rendered in the host locale,
  // and a Ukrainian-locale machine emits a date no English month table can read.
  const { stdout } = await run('/bin/ps', ['-eo', 'pid=,ppid=,lstart=,cputime=,comm='], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  });

  const rows: ProcessObservation[] = [];
  for (const line of stdout.split('\n')) {
    // `lstart` is exactly five whitespace-separated tokens ("Sun Aug 23 14:32:57 2026"),
    // and a space-padded day collapses into that split rather than adding a sixth.
    // `comm` is last because it is the only field that can itself contain spaces.
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 9) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const createdAt = Date.parse(parts.slice(2, 7).join(' '));
    const cpuMillis = parseCpuTime(parts[7]);
    const name = parts.slice(8).join(' ');
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!Number.isFinite(createdAt) || cpuMillis === null) continue;
    rows.push({ pid, ppid, createdAt, name, cpuMillis, suspended: null });
  }
  return rows;
}

async function readWindowsTable(): Promise<ProcessObservation[]> {
  // The same CIM class production uses, but reading four fields it never touches —
  // creation date, kernel time, user time and name — and formatting them for a parser
  // written here. Ticks rather than a formatted date, so no locale can reach this.
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { ' +
        '"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToUniversalTime().Ticks)|' +
        '$($_.KernelModeTime)|$($_.UserModeTime)|$($_.Name)" }'
    ],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  );

  const rows: ProcessObservation[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 6) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const ticks = Number(parts[2]);
    // 100-nanosecond units, both of them, as every Win32 time is.
    const cpuMillis = (Number(parts[3]) + Number(parts[4])) / 10_000;
    const name = parts.slice(5).join('|');
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!Number.isFinite(ticks) || !Number.isFinite(cpuMillis)) continue;
    rows.push({
      pid,
      ppid,
      createdAt: ticksToEpochMillis(ticks),
      name,
      cpuMillis,
      suspended: null
    });
  }
  return rows;
}

/** .NET ticks — 100 ns units since 0001-01-01 — to epoch milliseconds. */
function ticksToEpochMillis(ticks: number): number {
  return (ticks - 621_355_968_000_000_000) / 10_000;
}

/** `[[dd-]hh:]mm:ss[.ff]`, as `ps` writes cumulative CPU time. Never `%cpu`. */
function parseCpuTime(value: string | undefined): number | null {
  if (!value) return null;
  const [days, rest] = value.includes('-') ? value.split('-') : ['0', value];
  const fields = rest.split(':').map(Number);
  if (fields.length < 2 || fields.some(field => !Number.isFinite(field))) return null;
  const [hours, minutes, seconds] =
    fields.length === 3 ? fields : [0, fields[0] as number, fields[1] as number];
  const total =
    Number(days) * 86_400 +
    (hours as number) * 3_600 +
    (minutes as number) * 60 +
    (seconds as number);
  return Number.isFinite(total) ? total * 1_000 : null;
}

/**
 * `root` and everything descended from it, walked here rather than imported.
 *
 * Deliberately a second implementation of the same idea as `power/process-tree.ts`. If the
 * production walk has a bug, importing it would hide exactly the leak this looks for.
 */
export function treeRootedAt(
  rows: readonly ProcessObservation[],
  root: number
): ProcessObservation[] {
  const byParent = new Map<number, ProcessObservation[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }

  const collected: ProcessObservation[] = [];
  const seen = new Set<number>([root]);
  const self = rows.find(row => row.pid === root);
  if (self) collected.push(self);

  const queue = [root];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.pop() as number) ?? []) {
      // `seen` doubles as the cycle guard: a table captured mid-reparenting can contain a
      // loop, and re-walking it would never return.
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      collected.push(child);
      queue.push(child.pid);
    }
  }
  return collected;
}

/**
 * One observation of the machine.
 *
 * Pass the previous sample to get a share; the first sample of a run has no interval to
 * difference and reports zero.
 */
export async function sampleMachine(
  rootPid: number,
  previous?: MachineSample
): Promise<MachineSample> {
  const idleBefore = cpuTotals();
  const table = await readProcessTable();
  const at = Date.now();
  const tree = treeRootedAt(table, rootPid);
  const totalCapacityCores = os.cpus().length || 1;

  let sotySharePercent = 0;
  if (previous) {
    const elapsed = at - previous.at;
    if (elapsed > 0) {
      const spent = cpuSpentSince(previous, tree);
      sotySharePercent = (spent / (elapsed * totalCapacityCores)) * 100;
    }
  }

  const idleAfter = cpuTotals();
  const idleElapsed = idleAfter.total - idleBefore.total;
  const machineIdlePercent =
    idleElapsed > 0 ? ((idleAfter.idle - idleBefore.idle) / idleElapsed) * 100 : 0;

  return { at, tree, totalCapacityCores, sotySharePercent, machineIdlePercent };
}

/**
 * CPU consumed by the tree across the interval, in milliseconds.
 *
 * Per-process differencing rather than differencing the two totals, because a child that
 * exits between samples would otherwise remove its whole lifetime from the sum and produce
 * a negative share. A process that has vanished contributes nothing for the interval it
 * partly lived through — an under-report, and the harmless direction: the assertions that
 * matter here are about work that is still running, and a process that exited is precisely
 * what a passing stop looks like.
 */
function cpuSpentSince(previous: MachineSample, tree: readonly ProcessObservation[]): number {
  const before = new Map(previous.tree.map(row => [`${row.pid}:${row.createdAt}`, row.cpuMillis]));
  let spent = 0;
  for (const row of tree) {
    const seen = before.get(`${row.pid}:${row.createdAt}`);
    if (seen !== undefined) spent += Math.max(0, row.cpuMillis - seen);
    // New to the tree. If it was created inside the interval its whole cumulative time
    // belongs to the interval; if it is older it was reparented in, and the time it burned
    // before it joined is not this interval's.
    else if (row.createdAt >= previous.at) spent += row.cpuMillis;
  }
  return spent;
}

function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    for (const value of Object.values(cpu.times)) total += value;
  }
  return { idle, total };
}

/**
 * The identity of one known pid.
 *
 * For the case where the pid is already known exactly — a child that wrote its own pid to a
 * marker file, say. Deriving it from a tree walk instead means competing with whatever else
 * the harness happened to be running at that moment, including the probe's own `ps`.
 */
export async function handleFor(pid: number): Promise<ProcessHandle | null> {
  const row = (await readProcessTable()).find(candidate => candidate.pid === pid);
  return row ? { pid: row.pid, createdAt: row.createdAt, name: row.name } : null;
}

/** The identities of everything currently under `rootPid`, to check for survivors later. */
export async function handlesUnder(rootPid: number): Promise<ProcessHandle[]> {
  const tree = treeRootedAt(await readProcessTable(), rootPid);
  return tree.map(row => ({ pid: row.pid, createdAt: row.createdAt, name: row.name }));
}

/**
 * Which of `handles` are still alive — and whether each is running or merely suspended.
 *
 * The `(pid, createdAt)` pair is what makes a survivor a survivor. A pid alive again after
 * the operating system handed the number to something unrelated is not a leak, and calling
 * it one would produce a flake that trains people to ignore a red run.
 */
export async function survivorsOf(handles: readonly ProcessHandle[]): Promise<Survivor[]> {
  const candidates = handles.filter(handle => isAlive(handle.pid));
  if (candidates.length === 0) return [];

  // The table settles the identity question the syscall cannot: same number, different
  // process. Falling back to the syscall alone if the table cannot be read is deliberate —
  // reporting a possible leak beats silently reporting none.
  let table: ProcessObservation[];
  try {
    table = await readProcessTable();
  } catch {
    return candidates.map(handle => ({ handle, reason: 'left running' as const }));
  }

  const alive = new Map(table.map(row => [row.pid, row]));
  const survivors: Survivor[] = [];
  for (const handle of candidates) {
    const row = alive.get(handle.pid);
    // Absent from the table but alive to the syscall: it died between the two reads.
    if (!row) continue;
    // Recycled. Same number, a process that started after the one we were watching.
    if (Math.abs(row.createdAt - handle.createdAt) > CREATION_TOLERANCE_MS) continue;
    survivors.push({
      handle,
      reason: (await isSuspended(handle.pid)) ? 'left suspended' : 'left running'
    });
  }
  return survivors;
}

/**
 * `lstart` has one-second resolution, so the same process can read a second apart across
 * two samples. Two seconds is wide enough for that and far narrower than any window in
 * which the operating system would hand the same pid out again.
 */
const CREATION_TOLERANCE_MS = 2_000;

/**
 * Is this process suspended? Windows only — and never skipped there.
 *
 * A suspended orphan is in the table, answers `kill(pid,0)`, and consumes nothing, so every
 * other check this module performs reports it as a clean stop. It is the one failure the
 * design calls most consequential, and the only way to see it is to ask what its threads
 * are waiting for. Every thread parked with `WaitReason = Suspended` is the signature.
 *
 * Elsewhere this is `null`: suspension is SIGSTOP, which is visible in the process state
 * column and is not a state this application's Unix path can leave behind.
 */
export async function isSuspended(pid: number): Promise<boolean | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; ` +
          'if ($p) { $t = @($p.Threads); ' +
          '"$($t.Count) $(@($t | Where-Object { $_.WaitReason -eq \'Suspended\' }).Count)" }'
      ],
      { maxBuffer: 1024 * 1024, windowsHide: true }
    );
    const [total, suspended] = stdout.trim().split(/\s+/u).map(Number);
    if (!Number.isInteger(total) || !Number.isInteger(suspended) || total === 0) return false;
    return suspended === total;
  } catch {
    // Unreadable is not proof of innocence, but it is not proof of suspension either.
    return false;
  }
}

/** Formats survivors for a failure message that names the bug rather than the count. */
export function describeSurvivors(survivors: readonly Survivor[]): string {
  return survivors
    .map(({ handle, reason }) => `${reason}: ${handle.name} (pid ${handle.pid})`)
    .join('; ');
}
