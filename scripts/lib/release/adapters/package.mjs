import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'); const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk)); stream.once('error', reject); stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export function packageAction({ published, input }) {
  if (published) return { ok: false, code: 'PUBLISHED_REBUILD_FORBIDDEN' };
  if (!input?.runtimePath || !input?.outputPath) return { ok: false, code: 'PACKAGE_INPUT_INVALID' };
  return { ok: true };
}
