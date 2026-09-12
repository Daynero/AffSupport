import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PRODUCTION_SITE_ORIGIN,
  RELEASE_DOWNLOAD_URL,
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64
} from '../../../packages/shared/dist/release.js';
import { resolveTargetBinding, TargetError } from './targets.mjs';

/**
 * Where a release is allowed to write, stated once.
 *
 * Every verifier and adapter used to carry its own copy of the answer — an
 * origin here, a Cloudflare project name in an npm script, a repository in a
 * URL template. Each copy was a place a sandbox run could have leaked into
 * production, or a production run could have been quietly redirected. They all
 * read this module now, and the production binding is derived from the tracked
 * release constants rather than from anything a caller can supply.
 */

/** `Daynero/AffSupport`, taken from the tracked download URL rather than retyped. */
function releaseRepositoryFromDownloadUrl() {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\//u.exec(
    RELEASE_DOWNLOAD_URL
  );
  if (!match) throw new TargetError('Tracked release download URL does not name a repository');
  return match[1];
}

/**
 * The fingerprint of the public key releases are verified against. A sandbox
 * that signs with a different key therefore cannot collide with production
 * here, and a production run that somehow acquired a different key fails the
 * binding check before it writes anything.
 */
function signingKeyFingerprint(spkiBase64) {
  return createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex');
}

export function productionBinding() {
  const repository = releaseRepositoryFromDownloadUrl();
  return Object.freeze({
    kind: 'production',
    bindingId: 'production',
    repository,
    releaseRepository: repository,
    siteOrigin: PRODUCTION_SITE_ORIGIN,
    cloudflareProject: 'wishly-app',
    supabaseProject: 'yvvvignywfmbdgkcxtfk',
    signingKeyFingerprint: signingKeyFingerprint(RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64),
    artifactUrlBase: `https://github.com/${repository}/releases/download`
  });
}

/**
 * Resolves the binding this process must use.
 *
 * The default is production, pinned, and no environment value can redirect it:
 * `SOTY_RELEASE_BINDING` may only introduce a *sandbox* binding, which is then
 * checked to be disjoint from production in every destination field. That is
 * the whole safety property — "sandbox" is never a reason to verify less, only
 * a reason to write somewhere else.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function activeBinding(env = process.env) {
  const production = productionBinding();
  const configured = env.SOTY_RELEASE_BINDING;
  if (!configured) return resolveTargetBinding({ targetId: 'production', targetKind: 'production' }, { production });
  const candidate = JSON.parse(readFileSync(configured, 'utf8'));
  if (candidate?.kind !== 'sandbox')
    throw new TargetError('Only a sandbox binding may be supplied; production is pinned');
  return resolveTargetBinding(
    { targetId: candidate.bindingId, targetKind: 'sandbox' },
    { production, [candidate.bindingId]: candidate }
  );
}
