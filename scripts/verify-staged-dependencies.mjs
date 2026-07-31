import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagedAgentArgument = process.argv[2];

if (!stagedAgentArgument) {
  process.stderr.write(
    'Usage: node scripts/verify-staged-dependencies.mjs <staged-agent-directory>\n'
  );
  process.exit(1);
}

const stagedAgent = path.resolve(stagedAgentArgument);
const stagedNodeModules = path.join(stagedAgent, 'node_modules');
const packageLock = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8')
);
const stagedManifest = JSON.parse(
  await readFile(path.join(stagedAgent, 'production-dependencies.json'), 'utf8')
);

if (
  stagedManifest.schemaVersion !== 1 ||
  !Array.isArray(stagedManifest.dependencies) ||
  stagedManifest.dependencies.length === 0
) {
  throw new Error('The staged production dependency manifest is invalid.');
}

for (const relativePath of stagedManifest.dependencies) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error('The staged production dependency manifest contains an invalid path.');
  }
  const packageDirectory = path.resolve(stagedNodeModules, relativePath);
  if (!packageDirectory.startsWith(`${stagedNodeModules}${path.sep}`)) {
    throw new Error(`The staged dependency path escapes node_modules: ${relativePath}`);
  }

  const lockfilePath =
    relativePath === '@video-compressor/shared'
      ? 'packages/shared'
      : `node_modules/${relativePath}`;
  const lockedVersion = packageLock.packages?.[lockfilePath]?.version;
  const stagedPackage = JSON.parse(
    await readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  );
  if (!lockedVersion || stagedPackage.version !== lockedVersion) {
    throw new Error(
      `Staged dependency ${relativePath}@${stagedPackage.version ?? 'unknown'} ` +
        `does not match package-lock.json (${lockedVersion ?? 'missing'}).`
    );
  }
}

const browserManifest = JSON.parse(
  await readFile(path.join(stagedAgent, 'browser-runtime.json'), 'utf8')
);
if (
  browserManifest.schemaVersion !== 1 ||
  browserManifest.name !== 'chromium-headless-shell' ||
  typeof browserManifest.executableRelativePath !== 'string' ||
  typeof browserManifest.licenseRelativePath !== 'string'
) {
  throw new Error('The staged Chromium runtime manifest is invalid.');
}
const resolveBrowserFile = relativePath => {
  const target = path.resolve(stagedAgent, relativePath);
  const browserRoot = path.join(stagedAgent, 'browser');
  if (!target.startsWith(`${browserRoot}${path.sep}`)) {
    throw new Error(`The staged browser path escapes its runtime directory: ${relativePath}`);
  }
  return target;
};
const browserExecutable = resolveBrowserFile(browserManifest.executableRelativePath);
const browserLicense = resolveBrowserFile(browserManifest.licenseRelativePath);
for (const target of [browserExecutable, browserLicense]) {
  const details = await stat(target);
  if (!details.isFile() || details.size === 0) {
    throw new Error(`The staged browser file is missing or empty: ${target}`);
  }
}
const browserVersion = execFileSync(browserExecutable, ['--version'], {
  encoding: 'utf8',
  timeout: 15_000,
  windowsHide: true
}).trim();
if (!/(?:Chrome|Chromium)/iu.test(browserVersion)) {
  throw new Error(`The staged Chromium runtime returned an invalid version: ${browserVersion}`);
}

process.stdout.write(
  `Verified ${stagedManifest.dependencies.length} staged dependencies and ${browserVersion}.\n`
);
