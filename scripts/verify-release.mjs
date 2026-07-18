import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  AGENT_API_VERSION,
  BUILD_ID,
  BUILD_NUMBER,
  BUNDLE_VERSION,
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION,
  PRODUCT_VERSION,
  RELEASE_ARTIFACT_NAME,
  RELEASE_DOWNLOAD_URL,
  RELEASE_TAG
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
if (BUILD_ID !== `${PRODUCT_VERSION}+${BUILD_NUMBER}`) fail('build ID is not derived from version and build number');
if (
  AGENT_API_VERSION < MIN_SUPPORTED_AGENT_API_VERSION ||
  AGENT_API_VERSION > MAX_SUPPORTED_AGENT_API_VERSION
) {
  fail('current agent API is outside the declared web compatibility range');
}
if (RELEASE_TAG !== `v${PRODUCT_VERSION}` || !RELEASE_ARTIFACT_NAME.includes(`v${PRODUCT_VERSION}`)) {
  fail('tag or artifact name does not contain the product version');
}
if (!RELEASE_DOWNLOAD_URL.endsWith(`/${RELEASE_TAG}/${RELEASE_ARTIFACT_NAME}`)) {
  fail('download URL does not match the tag and artifact name');
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

  const existingTag = execFileSync('git', ['tag', '--list', RELEASE_TAG], { encoding: 'utf8' }).trim();
  if (packageMode && existingTag) fail(`${RELEASE_TAG} already exists locally and cannot be rebuilt`);
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
    const tagged = execFileSync('git', ['rev-list', '-n', '1', RELEASE_TAG], { encoding: 'utf8' }).trim();
    if (head !== tagged) fail(`${RELEASE_TAG} already belongs to another commit`);
  }
}

process.stdout.write(
  `Release ${PRODUCT_VERSION} (build ${BUILD_NUMBER}, API ${AGENT_API_VERSION}) is internally consistent.\n`
);
