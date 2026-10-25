import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, loadavg, freemem, totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';
const exec = promisify(execFile);

/** A bounded read, never a stress test or an instruction to stop somebody else's process. */
export async function webReleaseResources(root) {
  const disk = await statfs(root);
  let memoryFreePercent = (100 * freemem()) / totalmem();
  if (process.platform === 'darwin') {
    const { stdout } = await exec('/usr/bin/memory_pressure', ['-Q'], {
      timeout: 5000,
      maxBuffer: 8192
    });
    const match = /System-wide memory free percentage:\s*(\d+)%/u.exec(stdout);
    if (!match) throw new Error('WEB_RELEASE_RESOURCES_UNKNOWN');
    memoryFreePercent = Number(match[1]);
  }
  return {
    diskFreeBytes: disk.bavail * disk.bsize,
    memoryFreePercent,
    load: loadavg()[0],
    cores: cpus().length
  };
}

export function assertWebReleaseResources(sample) {
  if (
    !Number.isFinite(sample.diskFreeBytes) ||
    !Number.isFinite(sample.memoryFreePercent) ||
    !Number.isFinite(sample.load) ||
    !Number.isInteger(sample.cores) ||
    sample.cores < 1
  )
    throw new Error('WEB_RELEASE_RESOURCES_UNKNOWN');
  if (sample.diskFreeBytes < 3 * 1024 ** 3)
    throw new Error('WEB_RELEASE_WAIT_DISK: less than 3 GiB available');
  if (sample.memoryFreePercent < 15)
    throw new Error('WEB_RELEASE_WAIT_MEMORY: less than 15% memory headroom');
  if (sample.load > sample.cores * 2)
    throw new Error('WEB_RELEASE_WAIT_CPU: host load exceeds the bounded release budget');
}

/** @returns {Record<string, string>} */
export function boundedWebEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([, value]) => typeof value === 'string')
    ),
    NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ''} --max-old-space-size=1024`.trim(),
    GOMAXPROCS: '2',
    UV_THREADPOOL_SIZE: '2',
    RAYON_NUM_THREADS: '2'
  };
}
