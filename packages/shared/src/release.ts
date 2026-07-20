/**
 * Release identity is intentionally separate from the API contract version.
 *
 * Every published build gets a new PRODUCT_VERSION and BUILD_NUMBER. Published
 * tags/assets are immutable. AGENT_API_VERSION changes only when the web/agent
 * contract is incompatible, while the supported range lets a web release keep
 * working with older compatible agents.
 */
export const PRODUCT_VERSION = '0.5.2';
export const BUNDLE_VERSION = '0.5.2';
export const BUILD_NUMBER = '8';
export const RELEASE_CHANNEL = 'stable';

/**
 * The Wishly rebrand renamed the installed bundle from
 * "Local Video Compressor Agent.app" to "Wishly Agent.app", so replacing the
 * old app in place is impossible and mixed-brand pairs must not connect.
 * The API version is raised to force a clean upgrade path: the hosted page
 * tells an old agent to download Wishly Agent instead of half-working.
 */
export const AGENT_API_VERSION = 5;
export const MIN_SUPPORTED_AGENT_API_VERSION = 5;
export const MAX_SUPPORTED_AGENT_API_VERSION = 5;

/** User-facing product names. Technical identifiers (bundle id, npm scope,
 * the `product` handshake value, lock/support paths handled by the agent)
 * intentionally do not derive from these. */
export const PRODUCT_NAME = 'Wishly';
export const AGENT_PRODUCT_NAME = 'Wishly Agent';

/**
 * Single source for brand URLs. The hosted page runs on the free Cloudflare
 * Pages subdomain until a custom domain is purchased; swap this constant
 * (and config/production.env, which release checks keep in sync) to move.
 */
export const PRODUCTION_SITE_ORIGIN = 'https://wishly-app.pages.dev';
export const HELP_URL = `${PRODUCTION_SITE_ORIGIN}/help`;

export const BUILD_ID = `${PRODUCT_VERSION}+${BUILD_NUMBER}`;
export const RELEASE_TAG = `v${PRODUCT_VERSION}`;
export const RELEASE_ARTIFACT_NAME = `Wishly-Agent-v${PRODUCT_VERSION}-macOS-arm64.dmg`;
export const RELEASE_DOWNLOAD_URL = `https://github.com/Daynero/AffSupport/releases/download/${RELEASE_TAG}/${RELEASE_ARTIFACT_NAME}`;
