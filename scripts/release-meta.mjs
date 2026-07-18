import {
  AGENT_API_VERSION,
  BUILD_ID,
  BUILD_NUMBER,
  BUNDLE_VERSION,
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION,
  PRODUCT_VERSION,
  RELEASE_ARTIFACT_NAME,
  RELEASE_CHANNEL,
  RELEASE_DOWNLOAD_URL,
  RELEASE_TAG
} from '../packages/shared/dist/release.js';

const values = {
  'api-version': String(AGENT_API_VERSION),
  'artifact-name': RELEASE_ARTIFACT_NAME,
  'build-id': BUILD_ID,
  'build-number': BUILD_NUMBER,
  'bundle-version': BUNDLE_VERSION,
  'download-url': RELEASE_DOWNLOAD_URL,
  'max-api-version': String(MAX_SUPPORTED_AGENT_API_VERSION),
  'min-api-version': String(MIN_SUPPORTED_AGENT_API_VERSION),
  'product-version': PRODUCT_VERSION,
  'release-channel': RELEASE_CHANNEL,
  'release-tag': RELEASE_TAG
};

const key = process.argv[2];
if (key === '--json') {
  const sourceRevision = process.argv[3] ?? 'unknown';
  process.stdout.write(
    `${JSON.stringify(
      {
        productVersion: PRODUCT_VERSION,
        bundleVersion: BUNDLE_VERSION,
        buildNumber: BUILD_NUMBER,
        buildId: BUILD_ID,
        apiVersion: AGENT_API_VERSION,
        supportedAgentApi: {
          min: MIN_SUPPORTED_AGENT_API_VERSION,
          max: MAX_SUPPORTED_AGENT_API_VERSION
        },
        channel: RELEASE_CHANNEL,
        tag: RELEASE_TAG,
        artifact: RELEASE_ARTIFACT_NAME,
        downloadUrl: RELEASE_DOWNLOAD_URL,
        sourceRevision
      },
      null,
      2
    )}\n`
  );
} else if (key && Object.hasOwn(values, key)) {
  process.stdout.write(values[key]);
} else {
  process.stderr.write(`Unknown release metadata key: ${key ?? '(missing)'}\n`);
  process.exit(2);
}
