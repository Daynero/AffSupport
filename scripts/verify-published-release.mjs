import { RELEASE_DOWNLOAD_URL } from '../packages/shared/dist/release.js';

let response;
try {
  response = await fetch(RELEASE_DOWNLOAD_URL, { method: 'HEAD', redirect: 'follow' });
} catch (error) {
  process.stderr.write(
    `Could not verify the published Agent: ${error instanceof Error ? error.message : error}\n`
  );
  process.exit(1);
}

if (!response.ok) {
  process.stderr.write(
    `The versioned Agent must be published before the web UI (${response.status} for ${RELEASE_DOWNLOAD_URL}).\n`
  );
  process.exit(1);
}

process.stdout.write(`Published Agent verified: ${RELEASE_DOWNLOAD_URL}\n`);
