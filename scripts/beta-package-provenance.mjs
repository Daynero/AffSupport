#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packagePayloadDigest } from './lib/web-only-proof.mjs';
const exec = promisify(execFile);

/** Written by packaging, then independently matched after the real runtime verification. */
export async function betaPackageProvenance({ cwd, action }) {
  const app = path.join(cwd, 'release/beta/Soty Beta.app');
  const file = path.join(cwd, 'release/beta/package-provenance.json');
  const metadata = JSON.parse(
    await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8')
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const git = async args =>
    (
      await exec('git', args, { cwd, env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
    ).stdout.trim();
  const head = await git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(metadata.sourceRevision ?? '') || metadata.channel !== 'beta')
    throw new Error('BETA_PACKAGE_PROVENANCE_INVALID');
  const payloadDigest = await packagePayloadDigest(app);
  if (action === 'record') {
    if (metadata.sourceRevision !== head) throw new Error('BETA_PACKAGE_SOURCE_MISMATCH');
    const record = {
      schemaVersion: 1,
      sourceRevision: head,
      payloadDigest,
      dirty: Boolean(await git(['status', '--porcelain', '--untracked-files=all'])),
      recordedAt: new Date().toISOString()
    };
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    return payloadDigest;
  }
  if (action !== 'verify') throw new Error('BETA_PACKAGE_PROVENANCE_ACTION_INVALID');
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (
    record.schemaVersion !== 1 ||
    record.dirty !== false ||
    record.sourceRevision !== metadata.sourceRevision ||
    record.payloadDigest !== payloadDigest
  )
    throw new Error('BETA_PACKAGE_PAYLOAD_CHANGED');
  await git(['merge-base', '--is-ancestor', record.sourceRevision, head]);
  const changes = await git(['diff', '--name-only', record.sourceRevision, head]);
  if (
    changes
      .split('\n')
      .filter(Boolean)
      .some(name => name !== 'apps/web/public/.well-known/wishly/stable.json')
  )
    throw new Error('BETA_PACKAGE_SOURCE_MISMATCH');
  return payloadDigest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2]?.replace(/^--/u, '');
    process.stdout.write(`${await betaPackageProvenance({ cwd: process.cwd(), action })}\n`);
  } catch {
    process.stderr.write(
      'BETA_PACKAGE_PROVENANCE_UNPROVEN: package the exact clean beta once before reusing it.\n'
    );
    process.exitCode = 1;
  }
}
