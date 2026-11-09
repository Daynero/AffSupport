// Shared implementation behind scripts/stage-agent-runtime.mjs (macOS
// packaging) and scripts/stage-windows-runtime.mjs (Windows staging). Copies
// the built Agent (dist + exact production node_modules) into a destination
// directory, verifying every dependency against package-lock.json first.
import { createHash } from 'node:crypto';
import { macosTarget } from './macos-target.mjs';
import { verifyMacosPayload, isMachOFile } from './macos-payload.mjs';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
const rootNodeModules = path.join(repositoryRoot, 'node_modules');

/**
 * Stages the Agent runtime (dist, package.json, production node_modules and a
 * production-dependencies.json manifest) into `destination`, which must be an
 * empty or missing directory outside the source tree. Returns the dependency
 * manifest that was written.
 */
export async function stageAgentRuntime(destination, options = {}) {
  if (options.arch !== undefined) macosTarget(options.arch);
  destination = path.resolve(destination);
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

  let dependencyOutput;
  try {
    dependencyOutput = execFileSync(
      'npm',
      ['ls', '--workspace', '@video-compressor/agent', '--omit=dev', '--all', '--json', '--long'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        // npm is npm.cmd on Windows; shell resolution handles both spellings.
        shell: process.platform === 'win32'
      }
    );
  } catch (error) {
    // npm ls exits 1 for unrelated extraneous dev packages even when the
    // Agent's production subtree is complete. Parse its JSON and validate the
    // subtree below; genuine missing Agent dependencies still fail there.
    const stdout =
      error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string'
        ? error.stdout
        : null;
    if (!stdout?.trim()) throw error;
    dependencyOutput = stdout;
  }

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
        relativePath !== path.join('@video-compressor', 'agent') &&
        relativePath !== path.join('@video-compressor', 'shared')
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

  const browserRuntime = await stageChromiumHeadlessShell(destination, options);

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
    ].sort(),
    browser: browserRuntime
  };
  await writeFile(
    path.join(destination, 'production-dependencies.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  return manifest;
}

export async function stageChromiumHeadlessShell(destination, options = {}) {
  const target = options.arch === undefined ? null : macosTarget(options.arch);
  const pinned = JSON.parse(
    await readFile(path.join(rootNodeModules, 'playwright-core/browsers.json'), 'utf8')
  ).browsers.find(browser => browser.name === 'chromium-headless-shell');
  if (!pinned) throw new Error('CHROMIUM_REVISION_UNPROVEN');
  if (
    target &&
    !options.browserSourceRoot &&
    !process.env.SOTY_CHROMIUM_SOURCE_ROOT &&
    (process.platform !== 'darwin' || process.arch !== target.arch)
  ) {
    throw new Error(
      'CHROMIUM_TARGET_INPUT_REQUIRED: provide SOTY_CHROMIUM_SOURCE_ROOT for cross-builds'
    );
  }
  const chromiumExecutable = chromium.executablePath();
  let chromiumInstallRoot = path.dirname(chromiumExecutable);
  while (
    path.dirname(chromiumInstallRoot) !== chromiumInstallRoot &&
    !/^chromium-\d+$/u.test(path.basename(chromiumInstallRoot))
  ) {
    chromiumInstallRoot = path.dirname(chromiumInstallRoot);
  }
  const match = /^chromium-(\d+)$/u.exec(path.basename(chromiumInstallRoot));
  if (!match) {
    throw new Error(
      `Could not locate Playwright's Chromium installation from ${chromiumExecutable}.`
    );
  }
  const sourceRoot =
    options.browserSourceRoot ??
    process.env.SOTY_CHROMIUM_SOURCE_ROOT ??
    path.join(path.dirname(chromiumInstallRoot), `chromium_headless_shell-${match[1]}`);
  if (
    match[1] !== pinned.revision ||
    path.basename(sourceRoot) !== `chromium_headless_shell-${pinned.revision}`
  )
    throw new Error('CHROMIUM_REVISION_MISMATCH');
  const sourceStats = await stat(sourceRoot).catch(() => null);
  if (!sourceStats?.isDirectory()) {
    throw new Error(
      `Playwright Chromium Headless Shell is missing at ${sourceRoot}. Run npm ci without --ignore-scripts before packaging.`
    );
  }
  const [sourceExecutable, sourceLicense] = await Promise.all([
    findBundledFile(sourceRoot, /^(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/u),
    findBundledFile(sourceRoot, /^LICENSE\.headless_shell$/u)
  ]);
  if (!sourceExecutable || !sourceLicense) {
    throw new Error('The Playwright Chromium download is incomplete (binary or license missing).');
  }

  if (target) {
    if (!(await isMachOFile(sourceExecutable))) throw new Error('CHROMIUM_NATIVE_INPUT_INVALID');
    await verifyMacosPayload(sourceRoot, target.arch);
  }
  const targetRoot = path.join(destination, 'browser', 'chromium-headless-shell');
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await cp(sourceRoot, targetRoot, { recursive: true });
  const executableRelativePath = path
    .relative(destination, path.join(targetRoot, path.relative(sourceRoot, sourceExecutable)))
    .split(path.sep)
    .join('/');
  const licenseRelativePath = path
    .relative(destination, path.join(targetRoot, path.relative(sourceRoot, sourceLicense)))
    .split(path.sep)
    .join('/');
  const browserRuntime = {
    name: 'chromium-headless-shell',
    revision: pinned.revision,
    version: pinned.browserVersion,
    ...(target ? { platform: 'macos', architecture: target.arch } : {}),
    executableSha256: createHash('sha256')
      .update(await readFile(sourceExecutable))
      .digest('hex'),
    executableRelativePath,
    licenseRelativePath
  };
  await writeFile(
    path.join(destination, 'browser-runtime.json'),
    `${JSON.stringify({ schemaVersion: 1, ...browserRuntime }, null, 2)}\n`,
    'utf8'
  );
  return browserRuntime;
}

async function findBundledFile(root, pattern) {
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && pattern.test(entry.name)) return candidate;
      if (entry.isDirectory()) queue.push(candidate);
    }
  }
  return null;
}
