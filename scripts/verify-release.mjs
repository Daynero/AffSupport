import { execFileSync } from 'node:child_process';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  AGENT_API_VERSION,
  AGENT_TOOL_CONTRACTS,
  BUILD_ID,
  BUILD_NUMBER,
  BUNDLE_VERSION,
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION,
  PRODUCT_VERSION,
  PRODUCTION_SITE_ORIGIN,
  RELEASE_ARTIFACT_NAME,
  RELEASE_DOWNLOAD_URL,
  RELEASE_DOWNLOAD_URLS,
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  RELEASE_TAG,
  REQUIRED_RELEASE_PLATFORMS,
  WEB_TOOL_REQUIREMENTS,
  releaseManifestSigningPayload,
  toolContractCompatible
} from '../packages/shared/dist/release.js';

function fail(message) {
  process.stderr.write(`Release check failed: ${message}\n`);
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(PRODUCT_VERSION)) {
  fail(`invalid product version ${PRODUCT_VERSION}`);
}
if (!/^\d+\.\d+\.\d+$/.test(BUNDLE_VERSION)) fail(`invalid bundle version ${BUNDLE_VERSION}`);
if (BUNDLE_VERSION !== PRODUCT_VERSION.split('-')[0]) {
  fail('bundle version must equal the numeric core of the product version');
}
if (!/^[1-9]\d*(?:\.\d+){0,2}$/.test(BUILD_NUMBER)) {
  fail(`build number ${BUILD_NUMBER} must be one to three positive numeric components`);
}
if (BUILD_ID !== `${PRODUCT_VERSION}+${BUILD_NUMBER}`)
  fail('build ID is not derived from version and build number');
if (
  AGENT_API_VERSION < MIN_SUPPORTED_AGENT_API_VERSION ||
  AGENT_API_VERSION > MAX_SUPPORTED_AGENT_API_VERSION
) {
  fail('current agent API is outside the declared web compatibility range');
}
if (
  RELEASE_TAG !== `v${PRODUCT_VERSION}` ||
  !RELEASE_ARTIFACT_NAME.includes(`v${PRODUCT_VERSION}`)
) {
  fail('tag or artifact name does not contain the product version');
}
if (!RELEASE_DOWNLOAD_URL.endsWith(`/${RELEASE_TAG}/${RELEASE_ARTIFACT_NAME}`)) {
  fail('download URL does not match the tag and artifact name');
}

const stableManifest = JSON.parse(
  readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
);
if (
  stableManifest.schemaVersion !== 1 ||
  stableManifest.channel !== 'stable' ||
  stableManifest.version !== PRODUCT_VERSION ||
  stableManifest.buildNumber !== BUILD_NUMBER ||
  stableManifest.buildId !== BUILD_ID ||
  stableManifest.apiVersion !== AGENT_API_VERSION
) {
  fail('stable release manifest does not identify the build being verified');
}
if (JSON.stringify(stableManifest.toolRequirements) !== JSON.stringify(WEB_TOOL_REQUIREMENTS)) {
  fail('stable release manifest tool requirements differ from the web contract');
}
if (stableManifest.summary !== undefined) {
  if (
    !stableManifest.summary ||
    typeof stableManifest.summary !== 'object' ||
    Array.isArray(stableManifest.summary)
  ) {
    fail('stable release manifest summary must be a localized object');
  }
  for (const [language, summary] of Object.entries(stableManifest.summary)) {
    if (!['en', 'uk'].includes(language)) {
      fail(`stable release manifest summary contains unsupported language ${language}`);
    }
    if (typeof summary !== 'string' || !summary.trim() || summary.trim().length > 240) {
      fail(`stable release manifest summary for ${language} must contain 1-240 characters`);
    }
  }
}
// Every platform the release must ship (REQUIRED_RELEASE_PLATFORMS in the
// shared contract) has to be present and point at its own immutable artifact.
for (const platform of REQUIRED_RELEASE_PLATFORMS) {
  const artifact = stableManifest.artifacts?.[platform];
  if (!artifact) {
    fail(`stable release manifest is missing the required ${platform} artifact`);
  }
  const expectedUrl = RELEASE_DOWNLOAD_URLS[platform];
  if (expectedUrl && artifact.url !== expectedUrl) {
    fail(
      `stable release manifest ${platform} artifact does not point at the immutable release ` +
        `(expected ${expectedUrl})`
    );
  }
}
for (const [platform, artifact] of Object.entries(stableManifest.artifacts ?? {})) {
  if (!['macos-arm64', 'macos-x64', 'windows-x64'].includes(platform)) {
    fail(`stable release manifest contains unsupported platform ${platform}`);
  }
  if (!artifact?.url?.startsWith('https://') || !/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '')) {
    fail(`stable release manifest artifact ${platform} is incomplete`);
  }
}

// The web client refuses unsigned manifests, so a release must ship stable.json
// signed by the key matching RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64
// (scripts/sign-release-manifest.mjs).
if (typeof stableManifest.signature !== 'string' || stableManifest.signature.length === 0) {
  fail('stable release manifest is not signed; run scripts/sign-release-manifest.mjs');
}
const manifestSignatureValid = cryptoVerify(
  'sha256',
  Buffer.from(releaseManifestSigningPayload(stableManifest), 'utf8'),
  {
    key: createPublicKey({
      key: Buffer.from(RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64, 'base64'),
      format: 'der',
      type: 'spki'
    }),
    dsaEncoding: 'ieee-p1363'
  },
  Buffer.from(stableManifest.signature, 'base64url')
);
if (!manifestSignatureValid) {
  fail(
    'stable release manifest signature does not verify; re-run scripts/sign-release-manifest.mjs'
  );
}

const productionEnv = readFileSync('config/production.env', 'utf8');
const configuredOrigin = productionEnv.match(/^PUBLIC_SITE_ORIGIN=(.+)$/m)?.[1]?.trim();
if (configuredOrigin !== PRODUCTION_SITE_ORIGIN) {
  fail(
    `config/production.env PUBLIC_SITE_ORIGIN (${configuredOrigin}) does not match ` +
      `PRODUCTION_SITE_ORIGIN (${PRODUCTION_SITE_ORIGIN}) in packages/shared/src/release.ts`
  );
}
const configuredDriveOAuthMode = productionEnv.match(/^DRIVE_OAUTH_MODE=(.+)$/m)?.[1]?.trim();
if (configuredDriveOAuthMode !== 'verified') {
  fail(`production team OAuth requires DRIVE_OAUTH_MODE=verified, got ${configuredDriveOAuthMode}`);
}

const legacyContracts = { ...AGENT_TOOL_CONTRACTS };
delete legacyContracts.teamWorkspace;
if (toolContractCompatible('teamWorkspace', legacyContracts)) {
  fail('an agent without the teamWorkspace contract was accepted for team routes');
}
for (const tool of ['compressor', 'landingOptimizer', 'landingPreview', 'transcription']) {
  if (!toolContractCompatible(tool, legacyContracts)) {
    fail(`adding the teamWorkspace contract made legacy ${tool} incompatible`);
  }
}

for (const file of [
  'package.json',
  'apps/agent/package.json',
  'apps/web/package.json',
  'packages/shared/package.json'
]) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.version !== PRODUCT_VERSION) fail(`${file} has version ${manifest.version}`);
  if (
    manifest.dependencies?.['@video-compressor/shared'] &&
    manifest.dependencies['@video-compressor/shared'] !== PRODUCT_VERSION
  ) {
    fail(`${file} depends on a different shared release`);
  }
}

const packageMode = process.argv.includes('--package');
const deployMode = process.argv.includes('--deploy');
if (packageMode || deployMode) {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8'
  }).trim();
  if (status) fail('publishing requires a clean, committed worktree');

  const existingTag = execFileSync('git', ['tag', '--list', RELEASE_TAG], {
    encoding: 'utf8'
  }).trim();
  if (packageMode && existingTag)
    fail(`${RELEASE_TAG} already exists locally and cannot be rebuilt`);
  if (packageMode) {
    try {
      const remoteTag = execFileSync(
        'git',
        ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${RELEASE_TAG}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
      if (remoteTag) fail(`${RELEASE_TAG} is already published and cannot be rebuilt`);
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status !== 2) {
        fail('could not verify that the release tag is unused on origin');
      }
    }
  }
  if (deployMode) {
    if (!existingTag) fail(`${RELEASE_TAG} must exist locally before web deployment`);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const tagged = execFileSync('git', ['rev-list', '-n', '1', RELEASE_TAG], {
      encoding: 'utf8'
    }).trim();
    let remoteRefs;
    try {
      remoteRefs = execFileSync(
        'git',
        [
          'ls-remote',
          '--tags',
          'origin',
          `refs/tags/${RELEASE_TAG}`,
          `refs/tags/${RELEASE_TAG}^{}`
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
    } catch {
      fail(`could not verify ${RELEASE_TAG} on origin`);
    }
    const remoteLines = remoteRefs.split('\n').filter(Boolean);
    const peeled = remoteLines.find(line => line.endsWith(`refs/tags/${RELEASE_TAG}^{}`));
    const direct = remoteLines.find(line => line.endsWith(`refs/tags/${RELEASE_TAG}`));
    const remoteCommit = (peeled ?? direct)?.split(/\s+/)[0];
    if (!remoteCommit || remoteCommit !== tagged) {
      fail(`${RELEASE_TAG} on origin does not identify the local release commit`);
    }

    if (head !== tagged) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', tagged, head], { stdio: 'ignore' });
      } catch {
        fail(`${RELEASE_TAG} is not an ancestor of the web deployment commit`);
      }
      const agentReleaseInputs = [
        'apps/agent',
        'packaging',
        'packages/shared/src',
        'packages/shared/package.json',
        'config/production.env'
      ];
      const unreleasedAgentChanges = execFileSync(
        'git',
        ['diff', '--name-only', `${tagged}..${head}`, '--', ...agentReleaseInputs],
        { encoding: 'utf8' }
      ).trim();
      if (unreleasedAgentChanges) {
        fail(
          `web deployment includes Agent/shared changes not present in ${RELEASE_TAG}:\n${unreleasedAgentChanges}`
        );
      }
      process.stdout.write(
        `Web-only commit ${head.slice(0, 12)} is compatible with Agent release ${RELEASE_TAG}.\n`
      );
    }
  }
}

process.stdout.write(
  `Release ${PRODUCT_VERSION} (build ${BUILD_NUMBER}, API ${AGENT_API_VERSION}) is internally consistent.\n`
);
