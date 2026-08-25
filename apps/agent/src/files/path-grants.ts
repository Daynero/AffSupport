import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentPlatform } from '../platform/platform.js';

/**
 * The ledger of paths the user has actually chosen.
 *
 * The local app takes absolute paths from the browser — "compress this file",
 * "reveal that one", "write output here" — and until now the only thing
 * standing between an arbitrary path and the filesystem was the session token.
 * That makes the token's blast radius the whole disk, and it makes every new
 * route a place where somebody has to remember the rule (C3).
 *
 * A grant is minted only inside the code that *asks the user* to pick something:
 * a picker, a drop, a Finder action, or a restore from state that records an
 * earlier choice. Routes then take a grant id rather than a path. The
 * difference that matters is not cryptographic — a determined caller with the
 * token could ask the picker — it is that the set of reachable paths becomes
 * the set the user pointed at, and stays that way without anyone maintaining it.
 *
 * In memory only, and deliberately so: a grant file would be a second record of
 * what the user chose, and the moment it disagreed with the queue, one of them
 * would be wrong. The ledger is rebuilt on boot from the durable state it
 * authorises, so restoration and authorisation cannot drift.
 */

export type GrantKind = 'file' | 'dir';
export type GrantAccess = 'read' | 'write';
export type GrantOrigin = 'picker' | 'drop' | 'finder' | 'restore';

export interface PathGrant {
  id: string;
  /** Resolved at mint: comparison is only ever over real paths. */
  path: string;
  kind: GrantKind;
  access: GrantAccess;
  origin: GrantOrigin;
  /** Identity of the file at mint, re-checked at use. */
  dev: number;
  ino: number;
  createdAt: number;
  /** Null while durable state references it; otherwise it ages out. */
  expiresAt: number | null;
  refs: number;
}

/** How long an unreferenced grant survives without being used. */
export const IDLE_GRANT_TTL_MS = 24 * 60 * 60_000;

/**
 * The outer bound, applied even to a granted path.
 *
 * Defence in depth, and the only part of this file that would still help if the
 * ledger itself had a bug: it downgrades "read anything" to "read something in
 * the user's own documents". A path under one of these is refused whatever the
 * ledger says.
 */
/**
 * Resolves a boundary root the same way a candidate path is resolved.
 *
 * Both sides of the comparison have to be real paths or the check compares two
 * different things. macOS makes this concrete: `/etc` is a symlink to
 * `/private/etc`, so a candidate resolves to the second while a hand-written
 * list holds the first, and the bound silently matches nothing. A root that
 * does not exist on this machine resolves to itself, which is correct — it
 * simply never matches.
 */
function resolveBoundary(root: string): string {
  try {
    return normalizeForComparison(realpathSync(root));
  } catch {
    return normalizeForComparison(root);
  }
}

function isOutOfBounds(candidate: string): boolean {
  const home = os.homedir();
  const normalized = normalizeForComparison(candidate);
  const forbidden = [
    // Credential stores, on every platform. A grant must never reach these
    // even by way of a directory the user genuinely chose.
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, 'Library', 'Keychains'),
    path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Crypto')
  ].map(resolveBoundary);
  if (forbidden.some(root => normalized === root || normalized.startsWith(`${root}${path.sep}`))) {
    return true;
  }

  // The temporary directory is carved out before the system roots are
  // considered. On macOS it lives under `/private/var`, so a bound that names
  // `/var` swallows it — and the agent's own uploads, imports and render
  // scratch space all live there. Refusing them would break the ordinary path
  // while protecting nothing: a temp directory is not where credentials are.
  const temporary = resolveBoundary(os.tmpdir());
  if (normalized === temporary || normalized.startsWith(`${temporary}${path.sep}`)) return false;

  // System directories. Not an exhaustive list of everything dangerous — an
  // exhaustive list is not achievable — but the ones a mistake would reach first.
  const systemRoots = (
    currentPlatform() === 'win32'
      ? [process.env.SystemRoot ?? 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
      : ['/etc', '/var', '/usr', '/bin', '/sbin', '/System', '/Library']
  ).map(resolveBoundary);
  if (
    systemRoots.some(root => normalized === root || normalized.startsWith(`${root}${path.sep}`))
  ) {
    return true;
  }

  // Another user's home directory. `/Users/someone-else` resolves fine and is
  // exactly what a traversal lands in on a shared machine.
  const homeParent = path.dirname(home);
  const normalizedHome = normalizeForComparison(home);
  const normalizedParent = normalizeForComparison(homeParent);
  if (
    normalized.startsWith(`${normalizedParent}${path.sep}`) &&
    normalized !== normalizedHome &&
    !normalized.startsWith(`${normalizedHome}${path.sep}`)
  ) {
    return true;
  }
  return false;
}

/**
 * Case and separator normalisation for comparison.
 *
 * Windows compares paths case-insensitively, so `C:\Users\Me` and `c:\users\me`
 * are the same path and a case-sensitive ledger would be trivially bypassed.
 * POSIX is left alone: two names differing in case really are two files there.
 */
export function normalizeForComparison(candidate: string): string {
  const resolved = path.resolve(candidate);
  return currentPlatform() === 'win32' ? resolved.toLowerCase() : resolved;
}

export class PathGrantLedger {
  #grants = new Map<string, PathGrant>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Records a path the user chose. Returns null when the path is out of bounds
   * or does not exist.
   *
   * Called from inside the selection code paths and nowhere else — the whole
   * design rests on there being no other way in.
   */
  mint(
    candidate: string,
    options: { access?: GrantAccess; origin?: GrantOrigin; referenced?: boolean } = {}
  ): PathGrant | null {
    let resolved: string;
    let entry: ReturnType<typeof statSync>;
    try {
      // realpath first: a symlink chosen by the user is fine, but everything
      // downstream must compare against where it actually leads.
      resolved = realpathSync(candidate);
      entry = statSync(resolved);
    } catch {
      return null;
    }
    if (isOutOfBounds(resolved)) return null;
    if (!entry.isFile() && !entry.isDirectory()) return null;

    const at = this.now();
    const grant: PathGrant = {
      id: randomUUID(),
      path: resolved,
      kind: entry.isDirectory() ? 'dir' : 'file',
      access: options.access ?? 'read',
      origin: options.origin ?? 'picker',
      dev: entry.dev,
      ino: entry.ino,
      createdAt: at,
      expiresAt: options.referenced ? null : at + IDLE_GRANT_TTL_MS,
      refs: options.referenced ? 1 : 0
    };
    this.#grants.set(grant.id, grant);
    return grant;
  }

  /** The grant behind an id, if it is still live. */
  get(id: unknown): PathGrant | null {
    if (typeof id !== 'string') return null;
    const grant = this.#grants.get(id);
    if (!grant) return null;
    if (grant.expiresAt !== null && this.now() >= grant.expiresAt) {
      this.#grants.delete(id);
      return null;
    }
    return grant;
  }

  /**
   * Whether a path is authorised for this access right now.
   *
   * The identity re-check is the part that earns its keep. A job can sit in the
   * queue for minutes between the grant and the read, and swapping a symlink in
   * that window is the realistic attack — not guessing a grant id. Comparing
   * device and inode means the file being read is the file that was chosen, not
   * merely something that now answers to the same name.
   */
  authorises(candidate: string, access: GrantAccess): boolean {
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      return false;
    }
    if (isOutOfBounds(resolved)) return false;
    const normalized = normalizeForComparison(resolved);

    for (const grant of this.#grants.values()) {
      if (grant.expiresAt !== null && this.now() >= grant.expiresAt) continue;
      // A write grant satisfies a read; a read grant never satisfies a write.
      if (access === 'write' && grant.access !== 'write') continue;

      const granted = normalizeForComparison(grant.path);
      const covered =
        grant.kind === 'dir'
          ? normalized === granted || normalized.startsWith(`${granted}${path.sep}`)
          : normalized === granted;
      if (!covered) continue;

      // Identity is only checked for the grant's own path: a descendant of a
      // granted directory has its own inode, and requiring a match there would
      // mean minting a grant per file in a folder the user already chose.
      if (grant.kind === 'file' && !this.stillSameFile(grant)) continue;
      return true;
    }
    return false;
  }

  /** True when the granted path still leads to the same file it did at mint. */
  private stillSameFile(grant: PathGrant): boolean {
    try {
      const entry = statSync(grant.path);
      return entry.dev === grant.dev && entry.ino === grant.ino;
    } catch {
      return false;
    }
  }

  /** Marks a grant as referenced by durable state, so it stops ageing. */
  hold(id: string): void {
    const grant = this.#grants.get(id);
    if (!grant) return;
    grant.refs += 1;
    grant.expiresAt = null;
  }

  /** Releases a reference; the grant starts ageing again when none remain. */
  release(id: string): void {
    const grant = this.#grants.get(id);
    if (!grant) return;
    grant.refs = Math.max(0, grant.refs - 1);
    if (grant.refs === 0) grant.expiresAt = this.now() + IDLE_GRANT_TTL_MS;
  }

  /** Everything currently live. For diagnostics and boot rebuilding. */
  all(): PathGrant[] {
    const at = this.now();
    return [...this.#grants.values()].filter(
      grant => grant.expiresAt === null || at < grant.expiresAt
    );
  }

  /** Drops everything. Tests, and a full state reset. */
  clear(): void {
    this.#grants.clear();
    this.#wouldRefuse = 0;
  }

  #wouldRefuse = 0;
  #enforcing = false;

  /**
   * Checks a path and reports whether the caller may proceed.
   *
   * **Observe mode first, on purpose.** Turning a new authorisation check
   * straight on is how a security fix becomes an outage: every path the ledger
   * fails to account for is a user whose file stops working, and the ways it
   * can fail to account for one are exactly the ways nobody thought of. In
   * observe mode this counts what it *would* have refused and allows it, so the
   * rate can be read off the diagnostics page rather than guessed at, and the
   * switch is flipped once that number is zero in real use.
   */
  check(candidate: string, access: GrantAccess): boolean {
    if (this.authorises(candidate, access)) return true;
    this.#wouldRefuse += 1;
    return !this.#enforcing;
  }

  /** How many calls would have been refused. Read by the diagnostics surface. */
  wouldRefuseCount(): number {
    return this.#wouldRefuse;
  }

  /** Whether refusals are real. Off until the observed rate says it is safe. */
  enforcing(): boolean {
    return this.#enforcing;
  }

  setEnforcing(value: boolean): void {
    this.#enforcing = value;
  }
}

/**
 * The process-wide ledger.
 *
 * A singleton for the same reason the spawn governor is one: the alternative is
 * threading it through every route and every tool, and the one call site that
 * forgets is the hole.
 */
export const pathGrants = new PathGrantLedger();
