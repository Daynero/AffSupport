// Confirms every platform artifact the release must ship is actually
// downloadable before the web UI is deployed. The list comes from
// REQUIRED_RELEASE_PLATFORMS in the shared contract, so adding a platform there
// makes it release-blocking here too.
import {
  RELEASE_DOWNLOAD_URLS,
  REQUIRED_RELEASE_PLATFORMS
} from '../packages/shared/dist/release.js';
import { BETA_MARKERS } from '../packages/shared/dist/environment.js';
import { activeBinding } from './lib/release/bindings.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Reports and exits.
 *
 * Annotated `never` so the checker knows control does not continue past a call
 * — without it, every value guarded by a `fail()` reads as possibly undefined
 * further down, which is the shape most of this file's type errors took.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * A beta artifact must never be reachable through the update channel. It cannot
 * get there by construction — beta packaging never writes or signs stable.json,
 * and the download URLs are derived from the release contract — but the channel
 * is what users' installations actually follow, so the guarantee is asserted
 * here rather than assumed.
 */
for (const [platform, url] of Object.entries(RELEASE_DOWNLOAD_URLS)) {
  for (const marker of BETA_MARKERS) {
    if (typeof url === 'string' && url.includes(marker)) {
      fail(
        `RELEASE_BETA_IDENTITY: the ${platform} download URL carries the beta marker "${marker}".`
      );
    }
  }
}

// Downloading is not the same as downloading from the right place. A URL that
// does not start at this binding's artifact base is a destination mismatch, and
// checking it here is what stops a sandbox run from proving itself against
// production bytes (or the reverse).
const binding = activeBinding();

const manifest = JSON.parse(readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8'));
for (const platform of REQUIRED_RELEASE_PLATFORMS) {
  const url = RELEASE_DOWNLOAD_URLS[platform];
  if (!url) fail(`No download URL is defined for the required platform ${platform}.`);
  if (!url.startsWith(`${binding.artifactUrlBase}/`)) {
    fail(
      `The ${platform} download URL (${url}) is not published under the ` +
        `${binding.bindingId} artifact base ${binding.artifactUrlBase}.`
    );
  }

  let response;
  try {
    response = await fetch(url, { method: 'GET', redirect: 'follow' });
  } catch (error) {
    fail(
      `Could not verify the published ${platform} Agent: ` +
        `${error instanceof Error ? error.message : error}`
    );
  }

  if (!response.ok) {
    fail(
      `The versioned ${platform} Agent must be published before the web UI ` +
        `(${response.status} for ${url}).`
    );
  }

  const expected = manifest.artifacts?.[platform]?.sha256;
  if (!/^[a-f0-9]{64}$/u.test(expected ?? '')) fail(`No signed digest for ${platform}.`);
  const hash = createHash('sha256');
  if (!response.body) fail(`Published ${platform} response has no body.`);
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  if (hash.digest('hex') !== expected)
    fail(`Published ${platform} bytes do not match signed manifest.`);

  process.stdout.write(`Published Agent verified (${platform}): ${url}\n`);
}
