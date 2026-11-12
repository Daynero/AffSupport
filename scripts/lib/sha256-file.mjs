import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Streamed SHA-256 of one file as lowercase hex; the staged binaries run to 170 MB. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .once('error', reject)
      .on('data', chunk => hash.update(chunk))
      .once('end', () => resolve(hash.digest('hex')));
  });
}
