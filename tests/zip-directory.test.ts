import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { inspectArchive, ZIP_TAIL_BYTES } from '../supabase/functions/_shared/zip-directory';
import { runArchiveInspectionSlice } from '../supabase/functions/_shared/archive-inspection';

/**
 * Feature 011 (findings J2): the catalog tells a landing package from an
 * archive by its central directory alone, read from the file's tail.
 */

async function zip(entries: Record<string, string>): Promise<Buffer> {
  const file = new ZipFile();
  for (const [path, body] of Object.entries(entries)) file.addBuffer(Buffer.from(body), path);
  file.end();
  const chunks: Buffer[] = [];
  for await (const chunk of file.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function rangeReader(bytes: Buffer, log: Array<[number, number]> = []) {
  return async (start: number, end: number) => {
    log.push([start, end]);
    return new Uint8Array(bytes.subarray(start, end + 1));
  };
}

describe('inspectArchive', () => {
  it('calls a package with index.html at its root a landing, reading the tail only', async () => {
    const bytes = await zip({ 'index.html': '<h1>hi</h1>', 'css/site.css': 'body{}' });
    const reads: Array<[number, number]> = [];
    const result = await inspectArchive({
      fileSize: bytes.length,
      sourceVersion: '7',
      sourceChecksum: 'abc',
      fetchRange: rangeReader(bytes, reads)
    });
    expect(result).toMatchObject({ outcome: 'landing', landingRoot: '', entries: 2 });
    expect(result.outcome === 'landing' && /^[a-f0-9]{64}$/u.test(result.fingerprint)).toBe(true);
    expect(reads).toEqual([[0, bytes.length - 1]]);
  });

  it('finds the page one folder down and names that folder as the root', async () => {
    const bytes = await zip({ 'site/index.htm': '<p>', 'site/a/b.js': ';', 'README.txt': 'x' });
    const result = await inspectArchive({
      fileSize: bytes.length,
      sourceVersion: null,
      sourceChecksum: null,
      fetchRange: rangeReader(bytes)
    });
    expect(result).toMatchObject({ outcome: 'landing', landingRoot: 'site' });
  });

  it('leaves an archive without a page an archive, and a non-ZIP unavailable', async () => {
    const bytes = await zip({ 'photos/1.jpg': 'jpeg', 'notes.txt': 'n' });
    expect(
      await inspectArchive({
        fileSize: bytes.length,
        sourceVersion: null,
        sourceChecksum: null,
        fetchRange: rangeReader(bytes)
      })
    ).toEqual({ outcome: 'archive', entries: 2 });
    const text = Buffer.from('this is not a zip file at all, but it is long enough to look at');
    expect(
      await inspectArchive({
        fileSize: text.length,
        sourceVersion: null,
        sourceChecksum: null,
        fetchRange: rangeReader(text)
      })
    ).toEqual({ outcome: 'unavailable', reason: 'not_zip' });
  });

  it('reads only the tail of a large file, and the directory alone when it lies further up', async () => {
    // Incompressible bodies, so the file really is longer than the tail window.
    const { randomBytes } = await import('node:crypto');
    const big = randomBytes(ZIP_TAIL_BYTES * 2).toString('latin1');
    const bytes = await zip({ 'index.html': big, 'app.js': big });
    const reads: Array<[number, number]> = [];
    const result = await inspectArchive({
      fileSize: bytes.length,
      sourceVersion: '1',
      sourceChecksum: null,
      fetchRange: rangeReader(bytes, reads)
    });
    expect(result).toMatchObject({ outcome: 'landing', entries: 2 });
    expect(reads).toEqual([[bytes.length - ZIP_TAIL_BYTES, bytes.length - 1]]);

    // The same package with 70 KB of nothing between the directory and the end
    // record: the tail holds the record but not the entries, which take one more
    // read — of exactly the directory.
    const eocdAt = bytes.length - 22;
    const directoryOffset = bytes.readUInt32LE(eocdAt + 16);
    const directorySize = bytes.readUInt32LE(eocdAt + 12);
    const padded = Buffer.concat([
      bytes.subarray(0, eocdAt),
      Buffer.alloc(70 * 1024),
      bytes.subarray(eocdAt)
    ]);
    const paddedReads: Array<[number, number]> = [];
    const again = await inspectArchive({
      fileSize: padded.length,
      sourceVersion: '1',
      sourceChecksum: null,
      fetchRange: rangeReader(padded, paddedReads)
    });
    expect(again).toMatchObject({ outcome: 'landing', entries: 2 });
    expect(paddedReads).toHaveLength(2);
    expect(paddedReads[1]).toEqual([directoryOffset, directoryOffset + directorySize - 1]);
  });

  it('gives the fingerprint the agent would, for the same entries', async () => {
    // The agent's createLandingValidationRecord hashes version, checksum, root and the
    // sorted entry lines; a package with one known entry has one known digest.
    const bytes = await zip({ 'index.html': 'hello' });
    const result = await inspectArchive({
      fileSize: bytes.length,
      sourceVersion: 'v1',
      sourceChecksum: 'c1',
      fetchRange: rangeReader(bytes)
    });
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    hash.update('v1').update('\0').update('c1').update('\0').update('').update('\n');
    hash
      .update('index.html')
      .update('\0')
      .update('f')
      .update('\0')
      .update(String(7))
      .update('\0')
      .update(String(5))
      .update('\0')
      .update(String(0x3610a686))
      .update('\n');
    expect(result).toMatchObject({ outcome: 'landing', fingerprint: hash.digest('hex') });
  });
});

describe('runArchiveInspectionSlice', () => {
  it('commits one decision per row, including a provider refusal', async () => {
    const landing = await zip({ 'index.html': '<p>' });
    const bytesByFile: Record<string, Buffer> = { 'f-landing': landing };
    const commits: Array<[string, string]> = [];
    const row = (id: string) => ({
      materialId: `m-${id}`,
      teamId: 'team',
      credentialId: 'cred',
      driveFileId: id,
      resourceKey: null,
      driveVersion: '3',
      checksum: null,
      sizeBytes: bytesByFile[id]?.length ?? 5000
    });
    const summary = await runArchiveInspectionSlice([row('f-landing'), row('f-refused')], {
      fetchRange: async (current, start, end) => {
        const bytes = bytesByFile[current.driveFileId];
        return bytes ? new Uint8Array(bytes.subarray(start, end + 1)) : null;
      },
      commit: async (current, inspection) => {
        commits.push([current.materialId, inspection.outcome]);
      }
    });
    expect(summary).toEqual({ landings: 1, archives: 0, unavailable: 1 });
    expect(commits).toEqual([
      ['m-f-landing', 'landing'],
      ['m-f-refused', 'unavailable']
    ]);
  });
});
