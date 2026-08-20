// Confirms every platform artifact the release must ship is actually
// downloadable before the web UI is deployed. The list comes from
// REQUIRED_RELEASE_PLATFORMS in the shared contract, so adding a platform there
// makes it release-blocking here too.
import {
  RELEASE_DOWNLOAD_URLS,
  REQUIRED_RELEASE_PLATFORMS
} from '../packages/shared/dist/release.js';
import { BETA_MARKERS } from '../packages/shared/dist/environment.js';

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

for (const platform of REQUIRED_RELEASE_PLATFORMS) {
  const url = RELEASE_DOWNLOAD_URLS[platform];
  if (!url) fail(`No download URL is defined for the required platform ${platform}.`);

  let response;
  try {
    response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
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

  process.stdout.write(`Published Agent verified (${platform}): ${url}\n`);
}
