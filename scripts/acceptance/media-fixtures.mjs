import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateLocalTarget } from './target.mjs';

/** Generates only synthetic local media; it does not connect a Drive account. */
export async function prepareMediaFixtures(target) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  const root = path.resolve('release/acceptance', target.namespace, 'media');
  await mkdir(root, { recursive: true });
  const video = path.join(root, 'synthetic-3s.mp4');
  try {
    await stat(video);
    const previous = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    const digest = createHash('sha256')
      .update(await readFile(video))
      .digest('hex');
    if (
      previous.campaignId !== target.namespace ||
      previous.synthetic !== true ||
      previous.files?.[0]?.sha256 !== digest
    )
      throw new Error('ACCEPTANCE_MEDIA_FIXTURE_MISMATCH');
    return previous;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  }

  const result = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-n',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-threads',
      '1',
      video
    ],
    { shell: false, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 }
  );
  if (result.status !== 0) throw new Error('ACCEPTANCE_MEDIA_GENERATION_FAILED');
  const bytes = await readFile(video);
  const manifest = {
    schemaVersion: 1,
    campaignId: target.namespace,
    synthetic: true,
    files: [
      {
        path: 'media/synthetic-3s.mp4',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        durationSeconds: 3,
        dimensions: { width: 320, height: 180 },
        audio: '440Hz synthetic tone; not a spoken transcript fixture'
      }
    ],
    driveFixtureReady: false
  };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
