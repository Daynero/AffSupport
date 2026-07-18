/**
 * Release identity is intentionally separate from the API contract version.
 *
 * Every published build gets a new PRODUCT_VERSION and BUILD_NUMBER. Published
 * tags/assets are immutable. AGENT_API_VERSION changes only when the web/agent
 * contract is incompatible, while the supported range lets a web release keep
 * working with older compatible agents.
 */
export const PRODUCT_VERSION = '0.3.0-test.1';
export const BUNDLE_VERSION = '0.3.0';
export const BUILD_NUMBER = '2';
export const RELEASE_CHANNEL = 'test';

export const AGENT_API_VERSION = 4;
export const MIN_SUPPORTED_AGENT_API_VERSION = 4;
export const MAX_SUPPORTED_AGENT_API_VERSION = 4;

export const BUILD_ID = `${PRODUCT_VERSION}+${BUILD_NUMBER}`;
export const RELEASE_TAG = `v${PRODUCT_VERSION}`;
export const RELEASE_ARTIFACT_NAME = `LocalVideoCompressor-v${PRODUCT_VERSION}-macOS-arm64.dmg`;
export const RELEASE_DOWNLOAD_URL = `https://github.com/Daynero/AffSupport/releases/download/${RELEASE_TAG}/${RELEASE_ARTIFACT_NAME}`;
