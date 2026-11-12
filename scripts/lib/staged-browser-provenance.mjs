import path from 'node:path';
import { readSigningSummary } from './macos-signing-summary.mjs';
import { sha256File } from './sha256-file.mjs';

/**
 * The staged Chromium Headless Shell must be the pinned Playwright download, nothing
 * else. Before 048 that was byte equality with the digest staging recorded from the
 * download. The signing chain now re-signs every Mach-O in the bundle (hardened
 * runtime, JIT profile), so a signed package legitimately differs from the download;
 * then the chain's own summary has to close the gap: it received exactly the recorded
 * bytes (`before`) and the bundle still holds exactly what it produced (`after`).
 * Between those two digests the chain only removes and applies a code signature.
 * Without a summary the pre-048 equality still decides, so an unsigned staging
 * (Windows, a source run) keeps its old proof unchanged.
 * @param {{
 *   stagedAgent: string,
 *   browserExecutable: string,
 *   recordedSha256: unknown,
 *   signingFile?: string | null
 * }} input
 * @returns {Promise<{ attested: boolean, sha256: string }>}
 */
export async function assertStagedBrowserProvenance({
  stagedAgent,
  browserExecutable,
  recordedSha256,
  signingFile = null
}) {
  const actual = await sha256File(browserExecutable);
  if (recordedSha256 === undefined || actual === recordedSha256)
    return { attested: false, sha256: actual };
  if (typeof recordedSha256 !== 'string')
    throw new Error('The staged Chromium runtime manifest records an invalid digest.');
  if (!signingFile) throw new Error('The staged Chromium bytes differ from their recorded digest.');
  const signing = await readSigningSummary(signingFile);
  if (!signing.ok) throw new Error(`STAGED_BROWSER_SIGNING_SUMMARY_UNUSABLE: ${signing.error}`);
  // The staged agent lives at <App>.app/Contents/Resources/agent; the summary names the app.
  const app = path.resolve(stagedAgent, '..', '..', '..');
  if (path.basename(signing.value.app) !== path.basename(app))
    throw new Error(`STAGED_BROWSER_SIGNING_APP_MISMATCH: ${signing.value.app}`);
  const relative = path.relative(app, browserExecutable).split(path.sep).join('/');
  const entry = signing.value.files.find(file => file.path === relative);
  if (!entry || entry.profile !== 'chromium')
    throw new Error(`STAGED_BROWSER_NOT_SIGNED_BY_CHAIN: ${relative}`);
  if (entry.before !== recordedSha256)
    throw new Error('The signing chain did not receive the recorded Chromium bytes.');
  if (entry.after !== actual)
    throw new Error('The staged Chromium bytes differ from what the signing chain produced.');
  return { attested: true, sha256: actual };
}
