import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootNodeModules = path.join(repositoryRoot, 'node_modules');
const destinationArgument = process.argv[2];

if (!destinationArgument) {
  process.stderr.write('Usage: node scripts/stage-agent-runtime.mjs <destination>\n');
  process.exit(1);
}

const destination = path.resolve(destinationArgument);
if (
  destination === repositoryRoot ||
  destination === rootNodeModules ||
  destination.startsWith(`${rootNodeModules}${path.sep}`)
) {
  throw new Error(`Refusing to stage the runtime into a source directory: ${destination}`);
}

await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length > 0) {
  throw new Error(`Agent runtime destination must be empty: ${destination}`);
}

const dependencyOutput = execFileSync(
  'npm',
  ['ls', '--workspace', '@video-compressor/agent', '--omit=dev', '--all', '--json', '--long'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }
);

const dependencyTree = JSON.parse(dependencyOutput);
const agentTree = dependencyTree.dependencies?.['@video-compressor/agent'];
if (!agentTree) {
  throw new Error('npm did not report the Agent workspace dependency tree.');
}

// npm 11 can include unrelated, extraneous root packages in the parseable
// output even with --workspace and --omit=dev. Walk only the Agent subtree so a
// developer installation can never leak root test/build dependencies into the
// packaged runtime.
const productionSources = new Set();
function collectProductionSources(node) {
  for (const dependency of Object.values(node.dependencies ?? {})) {
    if (!dependency || typeof dependency !== 'object') continue;
    if (
      typeof dependency.path === 'string' &&
      dependency.path.startsWith(`${rootNodeModules}${path.sep}`)
    ) {
      productionSources.add(dependency.path);
    }
    collectProductionSources(dependency);
  }
}
collectProductionSources(agentTree);

const productionPackages = [...productionSources]
  .map(source => ({
    source,
    relativePath: path.relative(rootNodeModules, source)
  }))
  .filter(
    ({ relativePath }) =>
      relativePath !== '@video-compressor/agent' && relativePath !== '@video-compressor/shared'
  )
  .sort((left, right) => {
    const depthDifference =
      left.relativePath.split(path.sep).length - right.relativePath.split(path.sep).length;
    return depthDifference || left.relativePath.localeCompare(right.relativePath);
  });

if (productionPackages.length === 0) {
  throw new Error('npm did not report any production dependencies for the Agent workspace.');
}

// npm can report the lockfile's desired versions even when a developer's
// physical node_modules tree is stale. Packaging from those stale directories
// would silently reintroduce already-patched dependencies, so compare every
// source directory with the exact lockfile entry before copying anything.
const packageLock = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8')
);
for (const { source, relativePath } of productionPackages) {
  const lockfilePath = path.relative(repositoryRoot, source).split(path.sep).join('/');
  const lockedVersion = packageLock.packages?.[lockfilePath]?.version;
  const installedManifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (!lockedVersion || installedManifest.version !== lockedVersion) {
    throw new Error(
      `Installed dependency ${relativePath}@${installedManifest.version ?? 'unknown'} ` +
        `does not match package-lock.json (${lockedVersion ?? 'missing'}). Run npm ci before packaging.`
    );
  }
}

await cp(path.join(repositoryRoot, 'apps/agent/dist'), path.join(destination, 'dist'), {
  recursive: true
});
await cp(
  path.join(repositoryRoot, 'apps/agent/package.json'),
  path.join(destination, 'package.json')
);

for (const { source, relativePath } of productionPackages) {
  const sourceStats = await stat(source);
  if (!sourceStats.isDirectory()) throw new Error(`Dependency is not a directory: ${source}`);

  const target = path.join(destination, 'node_modules', relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    // npm reports nested production packages separately. Excluding each
    // package's nested node_modules prevents unrelated workspace/dev packages
    // from hitching a ride through the developer installation.
    filter(candidate) {
      if (candidate === source) return true;
      return !path.relative(source, candidate).split(path.sep).includes('node_modules');
    }
  });
}

const sharedTarget = path.join(destination, 'node_modules', '@video-compressor', 'shared');
await mkdir(sharedTarget, { recursive: true });
await cp(path.join(repositoryRoot, 'packages/shared/dist'), path.join(sharedTarget, 'dist'), {
  recursive: true
});
await cp(
  path.join(repositoryRoot, 'packages/shared/package.json'),
  path.join(sharedTarget, 'package.json')
);

const forbiddenPackages = [
  '@electric-sql',
  '@testing-library',
  'eslint',
  'jsdom',
  'prettier',
  'react',
  'react-dom',
  'tsx',
  'typescript',
  'vite',
  'vitest'
];
const topLevelPackages = new Set(await readdir(path.join(destination, 'node_modules')));
for (const packageName of forbiddenPackages) {
  if (topLevelPackages.has(packageName)) {
    throw new Error(`Development dependency leaked into the Agent runtime: ${packageName}`);
  }
}

const manifest = {
  schemaVersion: 1,
  dependencyCount: productionPackages.length + 1,
  dependencies: [
    ...productionPackages.map(({ relativePath }) => relativePath.split(path.sep).join('/')),
    '@video-compressor/shared'
  ].sort()
};
await writeFile(
  path.join(destination, 'production-dependencies.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
);

process.stdout.write(
  `Staged ${manifest.dependencyCount} production dependency packages for the Agent.\n`
);
