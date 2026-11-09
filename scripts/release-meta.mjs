import {
  AGENT_API_VERSION,
  BUILD_ID,
  BUILD_NUMBER,
  BUNDLE_VERSION,
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION,
  PRODUCT_VERSION,
  RELEASE_ARTIFACT_NAME,
  RELEASE_ARTIFACT_NAME_WINDOWS,
  RELEASE_ARTIFACT_NAME_MACOS_X64,
  RELEASE_CHANNEL,
  RELEASE_DOWNLOAD_URL,
  RELEASE_DOWNLOAD_URL_WINDOWS,
  RELEASE_DOWNLOAD_URL_MACOS_X64,
  RELEASE_TAG
} from '../packages/shared/dist/release.js';
import { parseMacosTarget } from './lib/macos-target.mjs';

const values = {
  'api-version': String(AGENT_API_VERSION),
  'artifact-name': RELEASE_ARTIFACT_NAME,
  'intel-artifact-name': RELEASE_ARTIFACT_NAME_MACOS_X64,
  'intel-download-url': RELEASE_DOWNLOAD_URL_MACOS_X64,
  'build-id': BUILD_ID,
  'build-number': BUILD_NUMBER,
  'bundle-version': BUNDLE_VERSION,
  'download-url': RELEASE_DOWNLOAD_URL,
  'max-api-version': String(MAX_SUPPORTED_AGENT_API_VERSION),
  'min-api-version': String(MIN_SUPPORTED_AGENT_API_VERSION),
  'product-version': PRODUCT_VERSION,
  'release-channel': RELEASE_CHANNEL,
  'release-tag': RELEASE_TAG,
  'windows-artifact-name': RELEASE_ARTIFACT_NAME_WINDOWS,
  'windows-download-url': RELEASE_DOWNLOAD_URL_WINDOWS
};

const key = process.argv[2];
if (key === '--json') {
  const sourceRevision = process.argv[3] ?? 'unknown';
  const targetArgs = process.argv.slice(4);
  const target =
    targetArgs.length === 1 && targetArgs[0] === '--platform=windows-x64'
      ? { platform: 'windows-x64', arch: 'x64' }
      : parseMacosTarget(targetArgs);
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
        artifact:
          target.platform === 'windows-x64'
            ? RELEASE_ARTIFACT_NAME_WINDOWS
            : target.arch === 'x64'
              ? RELEASE_ARTIFACT_NAME_MACOS_X64
              : RELEASE_ARTIFACT_NAME,
        target: target.platform,
        architecture: target.arch,
        downloadUrl:
          target.platform === 'windows-x64'
            ? RELEASE_DOWNLOAD_URL_WINDOWS
            : target.arch === 'x64'
              ? RELEASE_DOWNLOAD_URL_MACOS_X64
              : RELEASE_DOWNLOAD_URL,
        windowsArtifact: RELEASE_ARTIFACT_NAME_WINDOWS,
        windowsDownloadUrl: RELEASE_DOWNLOAD_URL_WINDOWS,
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
