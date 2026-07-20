/**
 * Release identity is intentionally separate from the API contract version.
 *
 * Every published build gets a new PRODUCT_VERSION and BUILD_NUMBER. Published
 * tags/assets are immutable. AGENT_API_VERSION changes only when the web/agent
 * contract is incompatible, while the supported range lets a web release keep
 * working with older compatible agents.
 */
export const PRODUCT_VERSION = '0.5.5';
export const BUNDLE_VERSION = '0.5.5';
export const BUILD_NUMBER = '11';
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

/**
 * Product versions identify immutable binaries. Contracts identify whether a
 * particular local tool can safely serve a particular web client. Keeping the
 * two separate prevents a newer development build from being offered a stable
 * downgrade and lets compatible older builds keep working.
 */
export const CORE_CONTRACT_VERSION = 1;
export const AGENT_TOOL_CONTRACTS = {
  compressor: 2,
  imageEmbedding: 1,
  landingOptimizer: 1
} as const;

export const WEB_TOOL_REQUIREMENTS = {
  compressor: { compressor: 2 },
  landingOptimizer: { landingOptimizer: 1 }
} as const;

export type ToolContractName = keyof typeof AGENT_TOOL_CONTRACTS;
export type ToolContracts = Partial<Record<ToolContractName, number>>;
export type WishlyToolId = keyof typeof WEB_TOOL_REQUIREMENTS;
export type ReleasePlatform = 'macos-arm64' | 'macos-x64' | 'windows-x64';

export interface ReleaseArtifact {
  url: string;
  sha256: string | null;
}

export interface StableReleaseManifest {
  schemaVersion: 1;
  channel: 'stable';
  version: string;
  buildNumber: string;
  buildId: string;
  apiVersion: number;
  minimumSupportedVersion: string;
  publishedAt: string;
  artifacts: Partial<Record<ReleasePlatform, ReleaseArtifact>>;
  toolRequirements: Record<WishlyToolId, ToolContracts>;
}

export function normalizeToolContracts(
  contracts: unknown,
  capabilities: readonly string[] = [],
  apiVersion = 0
): ToolContracts {
  const normalized: ToolContracts = {};
  if (contracts && typeof contracts === 'object' && !Array.isArray(contracts)) {
    for (const name of Object.keys(AGENT_TOOL_CONTRACTS) as ToolContractName[]) {
      const value = (contracts as Record<string, unknown>)[name];
      if (Number.isInteger(value) && Number(value) > 0) normalized[name] = Number(value);
    }
  }
  // API v5 predates explicit contracts but shipped the complete compressor and
  // image-embedding contract. This bridge keeps that published release usable.
  if (apiVersion === 5) {
    normalized.compressor ??= 1;
    normalized.imageEmbedding ??= 1;
  }
  if (capabilities.includes('landing')) normalized.landingOptimizer ??= 1;
  return normalized;
}

export function toolContractCompatible(
  tool: WishlyToolId,
  contracts: ToolContracts,
  requirements: Record<WishlyToolId, ToolContracts> = WEB_TOOL_REQUIREMENTS
): boolean {
  return Object.entries(requirements[tool]).every(
    ([name, minimum]) => (contracts[name as ToolContractName] ?? 0) >= (minimum ?? 0)
  );
}

export function compareProductVersions(left: string, right: string): -1 | 0 | 1 | null {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    return match
      ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? null }
      : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] < b.numbers[index]) return -1;
    if (a.numbers[index] > b.numbers[index]) return 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) return xn < yn ? -1 : 1;
    if (xn !== null) return -1;
    if (yn !== null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
