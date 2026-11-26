import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { NativeUpdateDescriptor } from '@video-compressor/shared';
import { spawnTracked } from '../power/spawn.js';
import { AppUpdateError } from './coordinator.js';

const TEAM = /^[A-Z0-9]{10}$/u;

/**
 * A Developer ID Application certificate of exactly this team, under Apple's anchor.
 *
 * Sparkle checks the archive's EdDSA signature and that the new bundle's code signature is
 * *valid*, but it accepts a change of signing identity when the EdDSA signature verifies —
 * including an ad-hoc bundle with no team at all (1.7.0 qualification, 2026-11-26: a forged
 * ad-hoc candidate signed with the beta updater key replaced the app and ran). The publisher
 * promised by the signed descriptor has to be proven on the candidate's own bytes.
 */
export function developerIdRequirement(team: string): string {
  if (!TEAM.test(team)) throw new AppUpdateError('APP_UPDATE_IDENTITY_MISMATCH');
  return (
    '=anchor apple generic' +
    ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
    ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' +
    ` and certificate leaf[subject.OU] = "${team}"`
  );
}

export interface CandidateIdentityTools {
  ditto: string;
  codesign: string;
}
const SYSTEM_TOOLS: CandidateIdentityTools = {
  ditto: '/usr/bin/ditto',
  codesign: '/usr/bin/codesign'
};

function run(command: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Through the shared budget: extraction is the heaviest step of a verification.
    const child = spawnTracked(command, args, {
      toolId: 'native-app-update',
      stdio: 'ignore',
      signal
    });
    child.once('error', reject);
    child.once('close', code =>
      code === 0 ? resolve() : reject(new AppUpdateError('APP_UPDATE_IDENTITY_MISMATCH'))
    );
  });
}

/**
 * Prove, before consent is offered, that the prepared archive is the promised Soty: one
 * app bundle, signed by the descriptor's Developer ID team, carrying the descriptor's exact
 * build, source and target. The archive is already bound to the descriptor by SHA-256, and
 * Sparkle installs only bytes carrying the descriptor's own EdDSA signature, so these are the
 * bytes that would replace the app.
 */
export async function verifyNativeCandidateBundle(
  archive: string,
  candidate: NativeUpdateDescriptor,
  directory: string,
  signal: AbortSignal,
  tools: CandidateIdentityTools = SYSTEM_TOOLS
): Promise<void> {
  const requirement = developerIdRequirement(candidate.publisherTeamId);
  const work = await mkdtemp(path.join(directory, 'verify-'));
  try {
    await run(tools.ditto, ['-x', '-k', archive, work], signal);
    const entries = (await readdir(work)).filter(name => name !== '__MACOSX');
    if (entries.length !== 1 || !entries[0]!.endsWith('.app'))
      throw new AppUpdateError('APP_UPDATE_IDENTITY_MISMATCH');
    const app = path.join(work, entries[0]!);
    const info = await lstat(app);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AppUpdateError('APP_UPDATE_IDENTITY_MISMATCH');
    await run(tools.codesign, ['--verify', '--deep', '--strict', '-R', requirement, app], signal);
    const release: unknown = JSON.parse(
      await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8')
    );
    if (
      typeof release !== 'object' ||
      release === null ||
      (release as Record<string, unknown>).buildId !== candidate.buildId ||
      (release as Record<string, unknown>).sourceRevision !== candidate.sourceRevision ||
      (release as Record<string, unknown>).target !== candidate.target
    )
      throw new AppUpdateError('APP_UPDATE_IDENTITY_MISMATCH');
  } catch (error) {
    if (signal.aborted) throw new AppUpdateError('APP_UPDATE_INTERRUPTED');
    if (error instanceof AppUpdateError) throw error;
    throw new AppUpdateError('APP_UPDATE_IDENTITY_MISMATCH');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
