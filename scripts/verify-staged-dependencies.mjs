import { readFile } from 'node:fs/promises';
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

process.stdout.write(
  `Verified ${stagedManifest.dependencies.length} staged dependency versions against package-lock.json.\n`
);
