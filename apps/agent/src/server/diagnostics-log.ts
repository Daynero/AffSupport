import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DIAGNOSTIC_CATEGORIES,
  type DiagnosticCategory,
  type DiagnosticPropValue,
  type DiagnosticRecord
} from '@video-compressor/shared';

/**
 * The agent's bounded local journal of diagnostic facts (031 FR-054).
 *
 * What this is for: the support bundle the web builds from `/api/diagnostics` is shown to the
 * user in full and copied by them into a thread we read. Everything in it is therefore
 * published the moment it is written, which is why the journal keeps *categories* — a spawn
 * exited non-zero after under ten seconds, a stream subscriber was evicted for stalling, the
 * entitlement moved from active to grace — and never the thing itself. No path, no file name,
 * no URL, no command line, no stderr, no token. The sanitizer below is the fence: a writer that
 * hands it one of those loses the record and bumps a counter, rather than the journal gaining
 * a secret.
 *
 * Bounds: 2 000 records or 1 MiB in memory, whichever is reached first; `diagnostics.jsonl`
 * under Application Support, written atomically (temp file + rename) at most every five
 * seconds, rotated at 1 MiB with one previous file kept. The tail is read back at boot so the
 * sequence continues and the last boot's shutdown reason is still on the page.
 */

export const DIAGNOSTICS_MAX_RECORDS = 2_000;
export const DIAGNOSTICS_MAX_BYTES = 1_048_576;
export const DIAGNOSTICS_FILE_MAX_BYTES = 1_048_576;
export const DIAGNOSTICS_FLUSH_INTERVAL_MS = 5_000;
/** The most records one `since` page may carry; the route's default is 200. */
export const DIAGNOSTICS_PAGE_LIMIT = 500;
export const DIAGNOSTICS_PAGE_DEFAULT = 200;
export const DIAGNOSTICS_FILE_NAME = 'diagnostics.jsonl';

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;
const PROP_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/u;
const MAX_PROPS = 16;
const MAX_STRING_LENGTH = 64;
/** Substrings no vocabulary word contains, and every path, URL, address or credential does. */
const FORBIDDEN_FRAGMENTS = ['/', '\\', '://', 'token', 'bearer', '@'];
/**
 * Shapes no vocabulary word has and every file name does: whitespace (`Holiday 2026`) or a
 * lettered extension at the end (`holiday.mov`). The separators above catch a *path*; a bare
 * file name has none, and used to be kept (SC-009). `1.2.6` still passes.
 */
const FILE_NAME_SHAPES = [/\s/u, /\.[a-z0-9]*[a-z][a-z0-9]*$/iu];

const CATEGORIES: ReadonlySet<string> = new Set(DIAGNOSTIC_CATEGORIES);

export type DiagnosticProps = Record<string, DiagnosticPropValue>;

/**
 * Whether one property value may be kept.
 *
 * Exported so a test can enumerate the fence directly. A string is refused when it is long
 * enough to be prose, carries a separator (a path, a URL, a command line), or names a
 * credential — case-insensitively, since `Token` and `TOKEN` are the same leak.
 */
export function isSafeDiagnosticValue(value: unknown): value is DiagnosticPropValue {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_STRING_LENGTH) return false;
  const lowered = value.toLowerCase();
  if (FORBIDDEN_FRAGMENTS.some(fragment => lowered.includes(fragment))) return false;
  return !FILE_NAME_SHAPES.some(shape => shape.test(value));
}

/** Validates props as a whole; null when anything in them is refused. */
function sanitizeProps(props: unknown): DiagnosticProps | null | undefined {
  if (props === undefined) return undefined;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return null;
  const entries = Object.entries(props as Record<string, unknown>);
  if (entries.length > MAX_PROPS) return null;
  const clean: DiagnosticProps = {};
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (!PROP_KEY_PATTERN.test(key)) return null;
    if (!isSafeDiagnosticValue(value)) return null;
    clean[key] = value;
  }
  return clean;
}

/** Narrows one line read back from disk. Anything the fence would refuse now is dropped. */
function parseStoredRecord(line: string): DiagnosticRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const { seq, at, category, code, props } = raw as Record<string, unknown>;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof category !== 'string' || !CATEGORIES.has(category)) return null;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return null;
  const cleanProps = sanitizeProps(props);
  if (cleanProps === null) return null;
  const record: DiagnosticRecord = { seq, at, category: category as DiagnosticCategory, code };
  if (cleanProps && Object.keys(cleanProps).length > 0) record.props = cleanProps;
  return record;
}

export interface DiagnosticsLogOptions {
  /** Where the journal is persisted; null keeps it in memory only (tests, bare assemblies). */
  file?: string | null;
  now?: () => number;
  flushIntervalMs?: number;
  maxRecords?: number;
  maxBytes?: number;
  fileMaxBytes?: number;
}

export class DiagnosticsLog {
  private readonly file: string | null;
  private readonly now: () => number;
  private readonly flushIntervalMs: number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly fileMaxBytes: number;

  private readonly records: DiagnosticRecord[] = [];
  private readonly lines: string[] = [];
  private bytes = 0;
  private lastSeq = 0;
  private rejected = 0;

  /** Records with `seq` above this are not yet on disk. */
  private flushedSeq = 0;
  /** Size of the current journal file as last written, so rotation needs no stat. */
  private fileBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: DiagnosticsLogOptions = {}) {
    this.file = options.file ?? null;
    this.now = options.now ?? Date.now;
    this.flushIntervalMs = options.flushIntervalMs ?? DIAGNOSTICS_FLUSH_INTERVAL_MS;
    this.maxRecords = options.maxRecords ?? DIAGNOSTICS_MAX_RECORDS;
    this.maxBytes = options.maxBytes ?? DIAGNOSTICS_MAX_BYTES;
    this.fileMaxBytes = options.fileMaxBytes ?? DIAGNOSTICS_FILE_MAX_BYTES;
  }

  /**
   * Reads the tail of the persisted journal back, so the sequence continues and the previous
   * boot's last records are still served. Unreadable or malformed content is simply absent:
   * the journal is an aid, and a corrupt one must never stop the agent from starting.
   */
  async load(): Promise<void> {
    if (!this.file) return;
    const previous = await readLines(`${this.file}.1`);
    const current = await readLines(this.file);
    this.fileBytes = Buffer.byteLength(current.join('\n') + (current.length ? '\n' : ''), 'utf8');
    const parsed: DiagnosticRecord[] = [];
    for (const line of [...previous, ...current]) {
      const record = parseStoredRecord(line);
      if (record) parsed.push(record);
    }
    parsed.sort((left, right) => left.seq - right.seq);
    for (const record of parsed) {
      if (record.seq <= this.lastSeq) continue;
      this.lastSeq = record.seq;
      this.push(record, JSON.stringify(record));
    }
    this.flushedSeq = this.lastSeq;
  }

  /**
   * Appends one fact. Returns false — and counts the refusal — when the category, code or any
   * property would breach the fence; nothing of the refused record is kept.
   */
  record(category: DiagnosticCategory, code: string, props?: DiagnosticProps): boolean {
    if (this.closed) return false;
    if (!CATEGORIES.has(category) || typeof code !== 'string' || !CODE_PATTERN.test(code)) {
      this.rejected += 1;
      return false;
    }
    const cleanProps = sanitizeProps(props);
    if (cleanProps === null) {
      this.rejected += 1;
      return false;
    }
    const record: DiagnosticRecord = { seq: this.lastSeq + 1, at: this.now(), category, code };
    if (cleanProps && Object.keys(cleanProps).length > 0) record.props = cleanProps;
    this.lastSeq = record.seq;
    this.push(record, JSON.stringify(record));
    this.scheduleFlush();
    return true;
  }

  /** Records with `seq > since`, oldest first, at most `limit` (capped at the page limit). */
  since(since: number, limit: number = DIAGNOSTICS_PAGE_DEFAULT): DiagnosticRecord[] {
    const cap = Math.max(1, Math.min(DIAGNOSTICS_PAGE_LIMIT, Math.floor(limit)));
    const floor = Number.isFinite(since) ? since : 0;
    // The ring is ordered by seq, so the first qualifying index is a binary search away.
    let low = 0;
    let high = this.records.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.records[middle] as DiagnosticRecord).seq > floor) high = middle;
      else low = middle + 1;
    }
    return this.records.slice(low, low + cap).map(record => ({ ...record }));
  }

  /** The highest sequence number assigned so far; 0 before the first record. */
  latestSeq(): number {
    return this.lastSeq;
  }

  /** How many records writers tried to add and the fence refused. */
  rejectedCount(): number {
    return this.rejected;
  }

  /** Records currently held in memory. */
  size(): number {
    return this.records.length;
  }

  /** Serialized bytes currently held in memory. */
  byteSize(): number {
    return this.bytes;
  }

  /** Writes whatever is not yet on disk, now rather than on the timer. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushChain = this.flushChain.then(() => this.write()).catch(() => undefined);
    return this.flushChain;
  }

  /** Flushes and stops accepting records; for shutdown. */
  async close(): Promise<void> {
    if (this.closed) return this.flushChain;
    await this.flush();
    this.closed = true;
  }

  private push(record: DiagnosticRecord, line: string): void {
    this.records.push(record);
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line, 'utf8') + 1;
    while (
      this.records.length > 1 &&
      (this.records.length > this.maxRecords || this.bytes > this.maxBytes)
    ) {
      this.records.shift();
      const evicted = this.lines.shift() as string;
      this.bytes -= Buffer.byteLength(evicted, 'utf8') + 1;
    }
  }

  private scheduleFlush(): void {
    if (!this.file || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // Never hold the process open for bookkeeping.
    this.flushTimer.unref();
  }

  private async write(): Promise<void> {
    if (!this.file || this.flushedSeq >= this.lastSeq) return;
    const target = this.lastSeq;
    const pending: string[] = [];
    for (let index = 0; index < this.records.length; index += 1) {
      if ((this.records[index] as DiagnosticRecord).seq > this.flushedSeq) {
        pending.push(this.lines[index] as string);
      }
    }
    if (pending.length === 0) {
      this.flushedSeq = target;
      return;
    }
    const appended = pending.join('\n') + '\n';
    const appendedBytes = Buffer.byteLength(appended, 'utf8');
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      let existing = '';
      if (this.fileBytes + appendedBytes > this.fileMaxBytes) {
        // Rotation keeps exactly one previous file: the one being replaced takes its place.
        await rename(this.file, `${this.file}.1`).catch(() => undefined);
        this.fileBytes = 0;
      } else if (this.fileBytes > 0) {
        existing = await readFile(this.file, 'utf8').catch(() => '');
      }
      const content = existing + appended;
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, this.file);
      this.fileBytes = Buffer.byteLength(content, 'utf8');
      this.flushedSeq = target;
    } catch {
      // A journal that cannot be written is still a journal in memory, and the route still
      // serves it. The next flush tries again.
    }
  }
}

async function readLines(file: string): Promise<string[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter(line => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * The journal this process writes to, for call sites that cannot be handed one.
 *
 * The same shape as the power governor's process-wide registry, and for the same reason:
 * the spawn seam, the native pickers, the drop resolver, the stream hub and the entitlement
 * gate sit several frames below anything that holds the entrypoint's dependencies, and
 * threading a journal through every one of their signatures would touch dozens of call
 * sites for no behavioural gain. `buildServer` still receives it explicitly through its deps.
 * With nothing installed, `record` is a no-op — a bare test assembly sees exactly the
 * behaviour the code had before the journal existed.
 */
let activeLog: DiagnosticsLog | null = null;

export function setActiveDiagnosticsLog(log: DiagnosticsLog | null): void {
  activeLog = log;
}

export function activeDiagnosticsLogOrNull(): DiagnosticsLog | null {
  return activeLog;
}

/** `record` against the process-wide journal; silently a no-op when none is installed. */
export const diagnostics = {
  record(category: DiagnosticCategory, code: string, props?: DiagnosticProps): boolean {
    return activeLog ? activeLog.record(category, code, props) : false;
  }
};

/**
 * Buckets for the two numbers the journal most often wants to say something about without
 * saying the number: how long something took, and how many of something there were. Closed
 * vocabularies, so a record is a category and not a measurement that could identify a file.
 */
export function durationBucket(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  if (milliseconds < 1_000) return 'under_1s';
  if (milliseconds < 10_000) return 'under_10s';
  if (milliseconds < 60_000) return 'under_1m';
  if (milliseconds < 600_000) return 'under_10m';
  if (milliseconds < 3_600_000) return 'under_1h';
  return 'over_1h';
}

export function countBucket(count: number): string {
  if (!Number.isFinite(count) || count < 0) return 'unknown';
  if (count === 0) return 'none';
  if (count === 1) return 'one';
  if (count <= 5) return 'under_5';
  if (count <= 20) return 'under_20';
  if (count <= 100) return 'under_100';
  return 'over_100';
}

/** Signed clock-skew bucket: how far a peer's clock sits from this machine's. */
export function skewBucket(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return 'unknown';
  const magnitude = Math.abs(milliseconds);
  if (magnitude < 60_000) return 'under_1m';
  const direction = milliseconds > 0 ? 'ahead' : 'behind';
  if (magnitude < 300_000) return `${direction}_under_5m`;
  return `${direction}_over_5m`;
}
