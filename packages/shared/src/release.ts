/**
 * Release identity is intentionally separate from the API contract version.
 *
 * Every published build gets a new PRODUCT_VERSION and BUILD_NUMBER. Published
 * tags/assets are immutable. AGENT_API_VERSION changes only when the web/agent
 * contract is incompatible, while the supported range lets a web release keep
 * working with older compatible agents.
 */
export const PRODUCT_VERSION = '1.0.4';
export const BUNDLE_VERSION = '1.0.4';
export const BUILD_NUMBER = '62';
export const RELEASE_CHANNEL = 'stable';

/**
 * The Soty rebrand renamed the installed bundle from
 * "Wishly Agent.app" to "Soty.app", so replacing the
 * old app in place is impossible and mixed-brand pairs must not connect.
 * The API version is raised to force a clean upgrade path: the hosted page
 * tells an old agent to download Soty instead of half-working.
 */
export const AGENT_API_VERSION = 5;
export const MIN_SUPPORTED_AGENT_API_VERSION = 5;
export const MAX_SUPPORTED_AGENT_API_VERSION = 5;

/** User-facing product names. Technical identifiers (bundle id, npm scope,
 * the `product` handshake value, lock/support paths handled by the agent)
 * intentionally do not derive from these. */
export const PRODUCT_NAME = 'Soty';
export const AGENT_PRODUCT_NAME = 'Soty';

/**
 * Single source for brand URLs. Keep this constant and config/production.env
 * synchronized when moving the hosted app to another canonical origin.
 */
export const PRODUCTION_SITE_ORIGIN = 'https://soty.pp.ua';
export const HELP_URL = `${PRODUCTION_SITE_ORIGIN}/help`;

export const BUILD_ID = `${PRODUCT_VERSION}+${BUILD_NUMBER}`;
export const RELEASE_TAG = `v${PRODUCT_VERSION}`;
export const RELEASE_ARTIFACT_NAME = `Soty-v${PRODUCT_VERSION}-macOS-arm64.dmg`;
export const RELEASE_DOWNLOAD_URL = `https://github.com/Daynero/AffSupport/releases/download/${RELEASE_TAG}/${RELEASE_ARTIFACT_NAME}`;
/**
 * Windows installer produced by packaging/windows-installer.iss, attached to the
 * same immutable tag as the DMG (docs/WINDOWS.md).
 */
export const RELEASE_ARTIFACT_NAME_WINDOWS = `Soty-v${PRODUCT_VERSION}-Windows-x64.exe`;
export const RELEASE_DOWNLOAD_URL_WINDOWS = `https://github.com/Daynero/AffSupport/releases/download/${RELEASE_TAG}/${RELEASE_ARTIFACT_NAME_WINDOWS}`;

/**
 * Platforms a stable release MUST ship. Every gate reads this list, so making a
 * platform release-blocking is a single edit here rather than a change spread
 * across the verification scripts.
 *
 * Windows became release-blocking in 1.0.1 after the hosted pipeline passed its
 * install/use/uninstall smoke. A missing artifact on either supported platform
 * now blocks the web deploy and the other package from being presented as a
 * complete stable release.
 */
export const REQUIRED_RELEASE_PLATFORMS: readonly ReleasePlatform[] = [
  'macos-arm64',
  'windows-x64'
];

/** Download URL for each platform, derived so no gate hard-codes a link. */
export const RELEASE_DOWNLOAD_URLS: Partial<Record<ReleasePlatform, string>> = {
  'macos-arm64': RELEASE_DOWNLOAD_URL,
  'windows-x64': RELEASE_DOWNLOAD_URL_WINDOWS
};

/**
 * Product versions identify immutable binaries. Contracts identify whether a
 * particular local tool can safely serve a particular web client. Keeping the
 * two separate prevents a newer development build from being offered a stable
 * downgrade and lets compatible older builds keep working.
 */
export const CORE_CONTRACT_VERSION = 1;
export const AGENT_TOOL_CONTRACTS = {
  compressor: 3,
  imageEmbedding: 2,
  landingOptimizer: 2,
  landingPreview: 2,
  transcription: 5,
  teamWorkspace: 2,
  // Background landing renders for team spaces (011). Absent from
  // WEB_TOOL_REQUIREMENTS for the same reason as `power`: it is a capability
  // read directly from the contract (teamBackgroundRenderSupported in shared),
  // never a tool page, so an older agent is not asked rather than rejected.
  teamBackgroundRender: 1,
  // Server-wide power throttle. Deliberately absent from WEB_TOOL_REQUIREMENTS:
  // that map is the set of user-facing *tool pages*, and it is byte-compared
  // against the signed, published stable.json by verify-release.mjs. The power
  // control is not a tool page, so support is detected by reading this contract
  // directly (see powerThrottleSupported in apps/web).
  power: 1
} as const;

export const WEB_TOOL_REQUIREMENTS = {
  compressor: { compressor: 3, imageEmbedding: 2 },
  landingOptimizer: { landingOptimizer: 2 },
  landingPreview: { landingPreview: 2 },
  transcription: { transcription: 5 },
  // Existing team preview/download/process routes stay compatible with contract 1.
  // Feature-specific callers gate the new landing-render routes on contract 2.
  teamWorkspace: { teamWorkspace: 1 }
} as const;

export type ToolContractName = keyof typeof AGENT_TOOL_CONTRACTS;
export type ToolContracts = Partial<Record<ToolContractName, number>>;
export type SotyToolId = keyof typeof WEB_TOOL_REQUIREMENTS;
export type ReleasePlatform = 'macos-arm64' | 'macos-x64' | 'windows-x64';
export type ReleaseSummaryLanguage = 'en' | 'uk';

export interface ReleaseArtifact {
  url: string;
  sha256: string | null;
}

/**
 * Public half of the release-manifest signing keypair (ECDSA P-256, SPKI DER,
 * base64). The private key lives only on the release machine
 * (config/keys/release-manifest.private.pem, gitignored); the web client
 * verifies stable.json against this key before trusting any download URL, so
 * whoever controls the hosting alone cannot redirect updates.
 */
export const RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEs8USlWYC6IRAqs1oXnraBppaXG4/bN5qk3DGEPblz8UylOwDxtk1U/ROt2mMCA6DbM4ll6A0aP5qDTQvfb7pDg==';

/**
 * Canonical bytes covered by the manifest signature: the manifest without its
 * `signature` field, serialized with deterministically sorted keys so signer
 * and verifier agree regardless of property order.
 */
export function releaseManifestSigningPayload(manifest: object): string {
  const unsigned = { ...(manifest as Record<string, unknown>) };
  delete unsigned.signature;
  return JSON.stringify(sortKeysDeep(unsigned));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeysDeep(entry)])
    );
  }
  return value;
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
  /** Short user-facing release copy. Omit it to use the generic maintenance text. */
  summary?: Partial<Record<ReleaseSummaryLanguage, string>>;
  artifacts: Partial<Record<ReleasePlatform, ReleaseArtifact>>;
  toolRequirements: Record<SotyToolId, ToolContracts>;
  /** Base64url ECDSA P-256 (IEEE P1363) signature over releaseManifestSigningPayload(). */
  signature?: string;
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
  if (capabilities.includes('landing-preview')) normalized.landingPreview ??= 1;
  if (capabilities.includes('transcription')) normalized.transcription ??= 1;
  return normalized;
}

export function toolContractCompatible(
  tool: SotyToolId,
  contracts: ToolContracts,
  requirements: Record<SotyToolId, ToolContracts> = WEB_TOOL_REQUIREMENTS
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

/** Minimum `power` tool contract a web client needs to drive the throttle. */
export const MIN_POWER_CONTRACT = 1;

/**
 * True when the connected agent can honour a power limit. Read directly from
 * the advertised contracts rather than through `toolContractCompatible`, because
 * the power throttle is a server-wide facility, not one of the tool pages in
 * WEB_TOOL_REQUIREMENTS (which is byte-compared against the signed manifest).
 */
export function powerThrottleSupported(contracts: ToolContracts): boolean {
  return (contracts.power ?? 0) >= MIN_POWER_CONTRACT;
}
