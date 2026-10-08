import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
/** Incremental hash verification. Filesystem notifications are only wake-up hints. */
export class JournalObserver {
  constructor(file, runId) { this.file = file; this.runId = runId; this.offset = 0; this.partial = ''; this.events = []; this.digest = '0'.repeat(64); this.inode = null; this.decoder = new StringDecoder('utf8'); }
  async read() {
    const info = await stat(this.file).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (!info) return this.events;
    if (this.inode !== info.ino || info.size < this.offset) {
      this.offset = 0; this.partial = ''; this.events = []; this.digest = '0'.repeat(64); this.inode = info.ino; this.decoder = new StringDecoder('utf8');
    }
    if (info.size === this.offset) return this.events;
    const fd = await open(this.file, 'r');
    try {
      while (this.offset < info.size) {
        const buffer = Buffer.alloc(Math.min(65536, info.size - this.offset));
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead; this.partial += this.decoder.write(buffer.subarray(0, bytesRead));
        if (Buffer.byteLength(this.partial) > 1048576) throw new Error('JOURNAL_EVENT_TOO_LARGE');
        let end;
        while ((end = this.partial.indexOf('\n')) >= 0) {
          const line = this.partial.slice(0, end); this.partial = this.partial.slice(end + 1);
          const e = JSON.parse(line); const canonical = { ...e }; delete canonical.digest;
          const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
          if (e.runId !== this.runId || e.schemaVersion !== 1 || e.sequence !== this.events.length + 1 || e.previousDigest !== this.digest || e.digest !== digest) throw new Error('JOURNAL_CORRUPT');
          if (this.events.length >= 100000) throw new Error('JOURNAL_HISTORY_LIMIT');
          this.events.push(e); this.digest = digest;
        }
      }
    } finally { await fd.close(); }
    return this.events;
  }
}
