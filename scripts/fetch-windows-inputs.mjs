// Downloads and verifies every third-party file the Windows installer bundles,
// then extracts the members `scripts/stage-windows-runtime.mjs` expects.
//
// The manifest (packaging/windows/inputs.json) pins each input by exact sha256
// and byte size. Nothing here trusts the network: a size or hash mismatch aborts
// the build rather than producing an installer nobody can vouch for. No file is
// ever uploaded from a maintainer machine — this is what lets the Windows
// artifact be produced entirely by CI (spec FR-027).
//
//   node scripts/fetch-windows-inputs.mjs [--verify-only] [--manifest <path>] [destination]
//
// Without --verify-only it writes `<destination>/env.sh` and `<destination>/env.txt`
// with the staging environment variables, so a workflow step can source them
// before running stage-windows-runtime.mjs.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listZipEntries, unzipArchive } from './lib/windows-archives.mjs';
import { parseInputsManifest, releaseBlockers } from './lib/windows-inputs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const manifestIndex = args.indexOf('--manifest');
const manifestPath = path.resolve(
  manifestIndex === -1
    ? path.join(repositoryRoot, 'packaging', 'windows', 'inputs.json')
    : args[manifestIndex + 1]
);
const positional = args.filter(
  (argument, index) => !argument.startsWith('--') && index !== manifestIndex + 1
);
const destination = path.resolve(
  positional[0] ?? path.join(repositoryRoot, 'release', 'windows', 'inputs')
);

/**
 * Terminates the process. Annotated `never` so callers that use it inside a `.catch()`
 * narrow correctly — without this, `await fetchWithRetry(...).catch(error => fail(...))`
 * has type `void | Response` and every property read after it is unchecked.
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`Windows inputs failed: ${message}\n`);
  process.exit(1);
}

const DOWNLOAD_ATTEMPTS = 4;

async function fetchWithRetry(id, url) {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < DOWNLOAD_ATTEMPTS) {
      const delayMs = 1_000 * 2 ** (attempt - 1);
      process.stderr.write(
        `${id}: download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed; retrying in ${delayMs / 1_000}s\n`
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new Error('download failed');
}

async function downloadVerified(entry, into) {
  const url = entry.mirrorUrl ?? entry.upstreamUrl;
  const response = await fetchWithRetry(entry.id, url).catch(error => {
    fail(`${entry.id}: could not reach ${url} (${error.message})`);
  });
  if (!response.ok) fail(`${entry.id}: ${response.status} for ${url}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== entry.sizeBytes) {
    fail(`${entry.id}: expected ${entry.sizeBytes} bytes, got ${bytes.byteLength}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256) {
    fail(`${entry.id}: sha256 mismatch\n  expected ${entry.sha256}\n  actual   ${digest}`);
  }

  const file = path.join(into, `${entry.id}${entry.archiveKind === 'zip' ? '.zip' : '.bin'}`);
  await writeFile(file, bytes);
  return file;
}

async function stageEntry(entry, archiveFile, workDir) {
  const staged = [];
  if (entry.archiveKind === 'raw') {
    for (const target of entry.staging) {
      staged.push({ env: target.env, value: archiveFile });
    }
    return staged;
  }

  const extracted = path.join(workDir, `${entry.id}-extracted`);
  await mkdir(extracted, { recursive: true });
  const listed = await listZipEntries(archiveFile);
  await unzipArchive(archiveFile, extracted);

  for (const target of entry.staging) {
    const member = target.memberPath.replace(/\/+$/u, '');
    const present = listed.some(name => name === member || name.startsWith(`${member}/`));
    if (!present) fail(`${entry.id}: archive has no member ${target.memberPath}`);
    const resolved = path.join(extracted, ...member.split('/'));
    if (!existsSync(resolved)) fail(`${entry.id}: ${target.memberPath} did not extract`);
    staged.push({ env: target.env, value: resolved });
  }
  return staged;
}

// ---- run ------------------------------------------------------------------

if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`);
const parsed = parseInputsManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
// `fail` exits, but the parse result is a union and the checker follows it
// rather than the control flow; reading the value once it is known to be
// present says the same thing in a form it can verify.
if (!parsed.ok) fail(parsed.error ?? 'the inputs manifest could not be parsed');
const manifest = /** @type {NonNullable<typeof parsed.value>} */ (parsed.value);

const blockers = releaseBlockers(manifest);
// Downloadable inputs. `git` sources are cloned at their pinned commit by the
// build that consumes them; `built` inputs are compiled in CI, not fetched.
const pinned = manifest.inputs.filter(
  entry => entry.status === 'pinned' && entry.archiveKind !== 'git'
);
const gitSources = manifest.inputs.filter(
  entry => entry.status === 'pinned' && entry.archiveKind === 'git'
);
const built = manifest.inputs.filter(entry => entry.status === 'built');

if (verifyOnly) {
  for (const entry of pinned) {
    const url = entry.mirrorUrl ?? entry.upstreamUrl;
    process.stdout.write(
      `ok  ${entry.id.padEnd(20)} ${entry.sha256.slice(0, 12)}… ${String(entry.sizeBytes).padStart(10)} bytes  ${url}\n`
    );
  }
  for (const entry of gitSources) {
    process.stdout.write(
      `ok  ${entry.id.padEnd(20)} git ${entry.gitRevision.slice(0, 12)}…              ${entry.upstreamUrl}\n`
    );
  }
  for (const entry of built) {
    process.stdout.write(
      `ok  ${entry.id.padEnd(20)} built in CI from ${entry.builtFrom.join(' + ')}\n`
    );
  }
  for (const blocker of blockers) process.stdout.write(`pending  ${blocker}\n`);
  process.stdout.write(
    `\n${pinned.length + gitSources.length + built.length} input(s) resolved, ` +
      `${blockers.length} blocking a release build.\n`
  );
  process.exit(0);
}

if (blockers.length > 0) {
  fail(
    `these inputs are not usable yet, so no Windows installer can be built:\n  ` +
      `${blockers.join('\n  ')}\nSee research.md R3 and packaging/windows/inputs.json.`
  );
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const workDir = await mkdtemp(path.join(os.tmpdir(), 'soty-windows-inputs-'));
const environment = [];
try {
  for (const entry of pinned) {
    const archiveFile = await downloadVerified(entry, workDir);
    for (const { env, value } of await stageEntry(entry, archiveFile, workDir)) {
      const finalPath = path.join(destination, entry.id, path.basename(value));
      await mkdir(path.dirname(finalPath), { recursive: true });
      await cp(value, finalPath, { recursive: true });
      environment.push({ env, value: finalPath });
    }
    process.stdout.write(`verified ${entry.id} (${entry.sizeBytes} bytes, sha256 ok)\n`);
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}

await writeFile(
  path.join(destination, 'env.sh'),
  `${environment.map(({ env, value }) => `export ${env}=${JSON.stringify(value)}`).join('\n')}\n`
);
await writeFile(
  path.join(destination, 'env.txt'),
  `${environment.map(({ env, value }) => `${env}=${value}`).join('\n')}\n`
);
process.stdout.write(
  `\n${pinned.length} input(s) verified into ${destination}; staging variables written to env.sh and env.txt.\n`
);
