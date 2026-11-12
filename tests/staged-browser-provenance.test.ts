import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertStagedBrowserProvenance } from '../scripts/lib/staged-browser-provenance.mjs';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * 048 T009 found this: the signing chain re-signs the staged Chromium Headless Shell,
 * so `verify-staged-dependencies.mjs` could no longer match the bundle's bytes to the
 * digest staging recorded from the Playwright download. The chain's summary now has to
 * carry the lineage — received exactly the recorded bytes, left exactly these — and
 * nothing looser may pass.
 */

const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const upstream = 'chromium headless shell as downloaded';
const signed = 'chromium headless shell as the chain signed it';
const browserRelative =
  'Contents/Resources/agent/browser/chromium-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => removeTemporaryDirectory(directory)));
});

async function bundle(bytes: string, summary: Record<string, unknown> | null) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-browser-provenance-'));
  directories.push(root);
  const app = path.join(root, 'Soty Beta.app');
  const stagedAgent = path.join(app, 'Contents/Resources/agent');
  const browserExecutable = path.join(app, browserRelative);
  await mkdir(path.dirname(browserExecutable), { recursive: true });
  await writeFile(browserExecutable, bytes);
  const signingFile = path.join(root, 'signing.json');
  if (summary) await writeFile(signingFile, `${JSON.stringify(summary)}\n`);
  return { app, stagedAgent, browserExecutable, signingFile };
}

const summaryFor = (app: string, entry: Record<string, unknown>) => ({
  app,
  identity: 'adhoc',
  teamId: null,
  machO: 2,
  nestedBundles: 0,
  profiles: entry.profiles ?? { node: 0, chromium: 1, hardened: 0 },
  files: [
    {
      path: 'Contents/MacOS/SotyBetaAgent',
      profile: 'launcher',
      before: sha256('l0'),
      after: sha256('l1')
    },
    {
      path: browserRelative,
      profile: 'chromium',
      before: sha256(upstream),
      after: sha256(signed),
      ...entry
    }
  ],
  notarized: false,
  stapled: false,
  submissionId: null
});

describe('the staged Chromium against the signing chain (048)', () => {
  it('keeps the pre-048 byte equality when the bundle still holds the download', async () => {
    const { stagedAgent, browserExecutable } = await bundle(upstream, null);
    await expect(
      assertStagedBrowserProvenance({
        stagedAgent,
        browserExecutable,
        recordedSha256: sha256(upstream)
      })
    ).resolves.toEqual({ attested: false, sha256: sha256(upstream) });
    // A manifest without a digest (older staging) is not a proof either way; it still passes.
    await expect(
      assertStagedBrowserProvenance({ stagedAgent, browserExecutable, recordedSha256: undefined })
    ).resolves.toEqual({ attested: false, sha256: sha256(upstream) });
  });

  it('refuses re-signed bytes with no summary to vouch for them, as before 048', async () => {
    const { stagedAgent, browserExecutable } = await bundle(signed, null);
    await expect(
      assertStagedBrowserProvenance({
        stagedAgent,
        browserExecutable,
        recordedSha256: sha256(upstream)
      })
    ).rejects.toThrow('The staged Chromium bytes differ from their recorded digest.');
  });

  it('accepts re-signed bytes exactly when the chain received the download and produced the bundle', async () => {
    const { app, stagedAgent, browserExecutable, signingFile } = await bundle(signed, null);
    await writeFile(signingFile, `${JSON.stringify(summaryFor(app, {}))}\n`);
    await expect(
      assertStagedBrowserProvenance({
        stagedAgent,
        browserExecutable,
        recordedSha256: sha256(upstream),
        signingFile
      })
    ).resolves.toEqual({ attested: true, sha256: sha256(signed) });
  });

  it('rejects every break in the lineage', async () => {
    const cases: [Record<string, unknown> | null, string][] = [
      [
        { before: sha256('something else was signed') },
        'did not receive the recorded Chromium bytes'
      ],
      [
        { after: sha256('the bundle changed after signing') },
        'differ from what the signing chain produced'
      ],
      [
        { profile: 'hardened', profiles: { node: 0, chromium: 0, hardened: 1 } },
        'STAGED_BROWSER_NOT_SIGNED_BY_CHAIN'
      ],
      [{ path: 'Contents/Resources/agent/browser/other' }, 'STAGED_BROWSER_NOT_SIGNED_BY_CHAIN']
    ];
    for (const [entry, message] of cases) {
      const { app, stagedAgent, browserExecutable, signingFile } = await bundle(signed, null);
      await writeFile(signingFile, `${JSON.stringify(summaryFor(app, entry ?? {}))}\n`);
      await expect(
        assertStagedBrowserProvenance({
          stagedAgent,
          browserExecutable,
          recordedSha256: sha256(upstream),
          signingFile
        })
      ).rejects.toThrow(message);
    }
    const other = await bundle(signed, null);
    await writeFile(
      other.signingFile,
      `${JSON.stringify(summaryFor('/elsewhere/Soty.app', {}))}\n`
    );
    await expect(
      assertStagedBrowserProvenance({
        stagedAgent: other.stagedAgent,
        browserExecutable: other.browserExecutable,
        recordedSha256: sha256(upstream),
        signingFile: other.signingFile
      })
    ).rejects.toThrow('STAGED_BROWSER_SIGNING_APP_MISMATCH');
    const missing = await bundle(signed, null);
    await expect(
      assertStagedBrowserProvenance({
        stagedAgent: missing.stagedAgent,
        browserExecutable: missing.browserExecutable,
        recordedSha256: sha256(upstream),
        signingFile: missing.signingFile
      })
    ).rejects.toThrow('STAGED_BROWSER_SIGNING_SUMMARY_UNUSABLE: SIGNING_SUMMARY_MISSING');
  });
});
