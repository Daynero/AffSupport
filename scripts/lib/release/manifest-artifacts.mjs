import path from 'node:path';
import {
  PRODUCT_VERSION,
  REQUIRED_RELEASE_PLATFORMS,
  RELEASE_DOWNLOAD_URLS
} from '../../../packages/shared/dist/release.js';

/**
 * Artifact bookkeeping for scripts/sign-release-manifest.mjs, kept pure so the
 * refusals are testable without the release key.
 *
 * A current-version manifest missing a required platform gets that platform's
 * canonical URL with a zero sha256 placeholder (the prepare convention: the web
 * treats zeros as unavailable and the `manifest` step records the real digest).
 * Never null: the web refuses a whole manifest with an unpinned artifact.
 * `historical` re-signs an older channel exactly with its own platform set.
 */
export function completeManifestArtifacts(
  manifest,
  { historical = false, productVersion = PRODUCT_VERSION, urls = RELEASE_DOWNLOAD_URLS } = {}
) {
  manifest.artifacts ??= {};
  const missing = REQUIRED_RELEASE_PLATFORMS.filter(
    platform => !Object.hasOwn(manifest.artifacts, platform)
  );
  if (!missing.length || historical) return manifest;
  if (manifest.version !== productVersion)
    throw new Error(
      `Manifest ${manifest.version} lacks ${missing.join(', ')} and is not the current release ` +
        `${productVersion}; re-sign an older channel with --historical.`
    );
  for (const platform of missing)
    manifest.artifacts[platform] = { url: urls[platform], sha256: '0'.repeat(64) };
  return manifest;
}

/**
 * Canonical names are unique per platform, so an ARM image can never be hashed
 * into the Intel slot (or the reverse) by a swapped argument.
 */
export function manifestArtifactFor(manifest, artifactPath, platform) {
  if (!REQUIRED_RELEASE_PLATFORMS.includes(platform))
    throw new Error(`Unsupported --platform ${platform}.`);
  const artifact = manifest.artifacts?.[platform];
  if (!artifact) throw new Error(`Manifest has no ${platform} artifact to attach the checksum to.`);
  if (path.basename(artifactPath) !== path.posix.basename(new URL(artifact.url).pathname))
    throw new Error(
      `${path.basename(artifactPath)} is not the ${platform} artifact named by the manifest.`
    );
  return artifact;
}

/** Revision 2 is declared only once every required artifact carries a real digest. */
export function declaresCompletePlatformSet(manifest) {
  return REQUIRED_RELEASE_PLATFORMS.every(platform => {
    const sha256 = manifest.artifacts?.[platform]?.sha256 ?? '';
    return /^[a-f0-9]{64}$/u.test(sha256) && !/^0+$/u.test(sha256);
  });
}
