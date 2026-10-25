import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { loadEnv } from 'vite';
import {
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  releaseManifestSigningPayload,
  RELEASE_TAG
} from '../../packages/shared/dist/release.js';
import { outputDigest, readWebFile } from '../release-web-meta.mjs';
import { atomicRecord } from './release/task-store.mjs';
import { inspectWebOnlySource, comparePackagedAgentInputs } from './web-only-policy.mjs';

const exec = promisify(execFile);
export const MANIFEST_PATH = 'apps/web/public/.well-known/wishly/stable.json';
export const PROOF_PATH = 'release/automation/web-only-verification.json';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function valueDigest(value) {
  const sort = input =>
    Array.isArray(input)
      ? input.map(sort)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map(key => [key, sort(input[key])])
          )
        : input;
  return sha256(JSON.stringify(sort(value)));
}

export function assertProductionWebConfiguration(values) {
  if (
    values.VITE_LOCAL_DEV_AUTH === 'true' ||
    values.VITE_MOCK_DATA === 'true' ||
    (values.VITE_APP_ENVIRONMENT && values.VITE_APP_ENVIRONMENT !== 'production')
  )
    throw new Error('WEB_ONLY_PRODUCTION_AUTH_CONFIG_UNSAFE');
}

export function webConfiguration(cwd, mode = 'production') {
  const values = loadEnv(mode, cwd, 'VITE_');
  if (mode === 'production') assertProductionWebConfiguration(values);
  delete values.VITE_WEB_BUILD_ID;
  delete values.VITE_WEB_REVISION;
  return { values, digest: valueDigest({ mode, nodeEnv: 'production', values }) };
}

export function assertSameUpdateChannel(local, live, key = RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64) {
  if (!Buffer.from(local).equals(Buffer.from(live))) throw new Error('WEB_ONLY_CHANNEL_CHANGED');
  const manifest = JSON.parse(Buffer.from(local).toString('utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.channel !== 'stable' ||
    typeof manifest.signature !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(manifest.signature) ||
    !verify(
      'sha256',
      Buffer.from(releaseManifestSigningPayload(manifest)),
      {
        key: createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }),
        dsaEncoding: 'ieee-p1363'
      },
      Buffer.from(manifest.signature, 'base64url')
    )
  )
    throw new Error('WEB_ONLY_CHANNEL_UNSIGNED');
  return sha256(local);
}

export async function fetchLiveManifest(binding, fetcher = fetch) {
  const response = await fetcher(`${binding.siteOrigin}/.well-known/wishly/stable.json`, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error('WEB_ONLY_LIVE_CHANNEL_UNAVAILABLE');
  if (!response.body) throw new Error('WEB_ONLY_LIVE_CHANNEL_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 1024 * 1024) throw new Error('WEB_ONLY_LIVE_CHANNEL_INVALID');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, total);
}

/** Hash sealed package bytes with bounded memory; internal links are sealed as links. */
export async function packagePayloadDigest(directory) {
  const root = await realpath(directory);
  const hash = createHash('sha256');
  async function walk(relative = '') {
    const folder = path.join(root, relative);
    const directoryBefore = await lstat(folder);
    if (!directoryBefore.isDirectory() || (await realpath(folder)) !== folder)
      throw new Error('WEB_ONLY_PACKAGE_CHANGED');
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const next = path.posix.join(relative, entry.name);
      const file = path.join(root, next);
      const before = await lstat(file);
      hash.update(next);
      hash.update('\0');
      hash.update(`mode:${before.mode & 0o777}\0`);
      if (before.isDirectory()) {
        hash.update('directory\0');
        await walk(next);
      } else if (before.isSymbolicLink()) {
        const target = await realpath(file);
        if (!target.startsWith(`${root}${path.sep}`))
          throw new Error('WEB_ONLY_PACKAGE_LINK_ESCAPE');
        const lexical = await readlink(file);
        const after = await lstat(file);
        if (
          after.ino !== before.ino ||
          after.ctimeMs !== before.ctimeMs ||
          (await realpath(file)) !== target
        )
          throw new Error('WEB_ONLY_PACKAGE_CHANGED');
        hash.update(`link:${lexical}:${path.relative(root, target)}\0`);
      } else if (before.isFile() && before.nlink === 1) {
        hash.update('file\0');
        const handle = await open(file, 'r');
        try {
          const actual = await handle.stat();
          if (actual.ino !== before.ino || actual.dev !== before.dev)
            throw new Error('WEB_ONLY_PACKAGE_CHANGED');
          for await (const chunk of createReadStream(file, {
            fd: handle.fd,
            autoClose: false,
            highWaterMark: 128 * 1024
          }))
            hash.update(chunk);
          const after = await handle.stat();
          const named = await lstat(file);
          if (
            named.ino !== before.ino ||
            named.dev !== before.dev ||
            !named.isFile() ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            throw new Error('WEB_ONLY_PACKAGE_CHANGED');
        } finally {
          await handle.close();
        }
        hash.update('\0');
      } else throw new Error('WEB_ONLY_PACKAGE_FILE_UNSAFE');
    }
    const directoryAfter = await lstat(folder);
    if (
      directoryBefore.ino !== directoryAfter.ino ||
      directoryBefore.dev !== directoryAfter.dev ||
      directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
      directoryBefore.ctimeMs !== directoryAfter.ctimeMs ||
      entries.map(x => x.name).join('\0') !==
        (await readdir(folder)).sort((a, b) => a.localeCompare(b)).join('\0')
    )
      throw new Error('WEB_ONLY_PACKAGE_CHANGED');
  }
  await walk();
  return hash.digest('hex');
}

/** Existing full-beta record remains untouched; an old package must have real prior provenance. */
export async function inspectPackagedBeta(cwd, { backendPaths = [] } = {}) {
  const directory = path.join(cwd, 'release/beta/Soty Beta.app');
  const metadataBytes = await readFile(path.join(directory, 'Contents/Resources/release.json'));
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const record = JSON.parse(
    await readFile(path.join(cwd, 'release/beta/verification.json'), 'utf8')
  );
  if (
    !/^[a-f0-9]{40}$/u.test(metadata.sourceRevision ?? '') ||
    metadata.channel !== 'beta' ||
    !/^[a-f0-9]{40}$/u.test(record.sourceRevision ?? '') ||
    record.dirty !== false ||
    !Number.isFinite(Date.parse(record.verifiedAt)) ||
    record.packageDigest !== sha256(metadataBytes)
  )
    throw new Error('WEB_ONLY_PACKAGE_BASELINE_UNPROVEN');
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const git = async args =>
    (
      await exec('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd,
        env: gitEnv,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024
      })
    ).stdout.trim();
  await git(['merge-base', '--is-ancestor', metadata.sourceRevision, record.sourceRevision]);
  const baselineChanges = await git([
    'diff',
    '--name-only',
    metadata.sourceRevision,
    record.sourceRevision
  ]);
  // Full release verification may have followed its signed-manifest-only commit.
  if (
    baselineChanges
      .split('\n')
      .filter(Boolean)
      .some(name => name !== MANIFEST_PATH)
  )
    throw new Error('WEB_ONLY_PACKAGE_BASELINE_UNPROVEN');
  const inputs = await comparePackagedAgentInputs({
    cwd,
    packageSha: metadata.sourceRevision,
    agentRef: `refs/tags/${RELEASE_TAG}`,
    backendPaths
  });
  if (!inputs.ok) throw new Error('WEB_ONLY_PACKAGED_AGENT_DIFFERS');
  const provenance = JSON.parse(
    await readFile(path.join(cwd, 'release/beta/package-provenance.json'), 'utf8')
  );
  if (
    provenance.schemaVersion !== 1 ||
    provenance.sourceRevision !== metadata.sourceRevision ||
    provenance.dirty !== false ||
    !/^[a-f0-9]{64}$/u.test(provenance.payloadDigest ?? '') ||
    record.packagePayloadDigest !== provenance.payloadDigest ||
    provenance.payloadDigest !== (await packagePayloadDigest(directory))
  )
    throw new Error(
      'WEB_ONLY_PACKAGE_PROVENANCE_MISSING: prepare and verify beta once; mini releases never rebuild it'
    );
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', directory], {
    cwd,
    timeout: 30_000,
    maxBuffer: 16_384
  });
  return {
    directory,
    sourceSha: metadata.sourceRevision,
    buildId: metadata.buildId,
    payloadDigest: await packagePayloadDigest(directory),
    baselineDigest: valueDigest(record)
  };
}

export function validateWebOnlyProof(proof, expected, now = Date.now()) {
  if (proof?.backend && proof.backendDigest !== valueDigest(proof.backend))
    throw new Error('DB_WEB_PROOF_MISMATCH');
  if (
    !proof ||
    proof.schemaVersion !== 1 ||
    proof.kind !== 'web-only' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      proof.runId ?? ''
    ) ||
    !Number.isFinite(Date.parse(proof.verifiedAt)) ||
    Date.parse(proof.verifiedAt) > now + 60_000 ||
    now - Date.parse(proof.verifiedAt) > 30 * 60_000
  )
    throw new Error('WEB_ONLY_PROOF_EXPIRED_OR_INVALID');
  if (
    !/^[a-f0-9]{40}$/u.test(proof.sourceSha ?? '') ||
    !/^[a-f0-9]{40}$/u.test(proof.agentSha ?? '') ||
    !/^[a-f0-9]{40}$/u.test(proof.packageSourceSha ?? '') ||
    typeof proof.webBuildId !== 'string' ||
    proof.webBuildId !== `web:${proof.sourceSha}:${proof.configurationDigest?.slice(0, 12)}`
  )
    throw new Error('WEB_ONLY_PROOF_IDENTITY_INVALID');
  for (const key of [
    'sourceSha',
    'agentSha',
    'agentInputsDigest',
    'bindingDigest',
    'configurationDigest',
    'manifestDigest',
    'productionBundleDigest',
    'betaBundleDigest',
    'packageDigest',
    'packageSourceSha',
    'packageBaselineDigest'
  ])
    if (
      typeof expected[key] !== 'string' ||
      proof[key] !== expected[key] ||
      (key.endsWith('Digest') && !/^[a-f0-9]{64}$/u.test(proof[key]))
    )
      throw new Error(`WEB_ONLY_PROOF_MISMATCH: ${key}`);
  for (const check of [
    'static',
    'releaseFinal',
    'publishedArtifacts',
    'packagedRuntime',
    'candidateBrowser'
  ])
    if (proof.checks?.[check] !== 'passed') throw new Error(`WEB_ONLY_CHECK_UNPROVEN: ${check}`);
  return proof;
}

export async function writeWebOnlyProof(cwd, proof) {
  const file = path.join(cwd, PROOF_PATH);
  await atomicRecord(file, proof);
}

export async function assertStoredWebOnlyProof({
  cwd,
  binding,
  fetcher = fetch,
  backendPhase = 'publish'
}) {
  if (!['candidate', 'publish'].includes(backendPhase)) throw new Error('DB_PROOF_PHASE_INVALID');
  const proof = JSON.parse(await readFile(path.join(cwd, PROOF_PATH), 'utf8'));
  let backendPaths = [];
  if (proof.backend) {
    if (proof.backendDigest !== valueDigest(proof.backend))
      throw new Error('DB_WEB_PROOF_MISMATCH');
    const { verifyMiniDbBackendProof } = await import('./mini-db-release.mjs');
    backendPaths = (
      await verifyMiniDbBackendProof({
        cwd,
        binding,
        backend: proof.backend,
        sourceSha: proof.sourceSha,
        allowPrepared: backendPhase === 'candidate'
      })
    ).backendPaths;
  } else if (proof.backendDigest) throw new Error('DB_WEB_PROOF_MISMATCH');
  const source = await inspectWebOnlySource({ cwd, agentRef: RELEASE_TAG, backendPaths });
  if (!source.ok)
    throw new Error(`WEB_ONLY_INELIGIBLE: ${source.blockers.map(x => x.code).join(',')}`);
  const local = await readFile(path.join(cwd, MANIFEST_PATH));
  const manifestDigest = assertSameUpdateChannel(local, await fetchLiveManifest(binding, fetcher));
  const packaged = await inspectPackagedBeta(cwd, { backendPaths });
  const betaDirectory = path.join(cwd, 'release/web-only', source.sourceSha ?? '', 'beta');
  return validateWebOnlyProof(proof, {
    ...source,
    bindingDigest: binding.digest,
    configurationDigest: webConfiguration(cwd).digest,
    manifestDigest,
    productionBundleDigest: await outputDigest(path.join(cwd, 'apps/web/dist')),
    betaBundleDigest: await outputDigest(betaDirectory),
    packageDigest: packaged.payloadDigest,
    packageSourceSha: packaged.sourceSha,
    packageBaselineDigest: packaged.baselineDigest
  });
}

/** Sequential, bounded origin readback. Hosting directives are not publicly served assets. */
export async function verifyLiveWebBytes({ directory, binding, expectedDigest, fetcher = fetch }) {
  if (
    !/^[a-f0-9]{64}$/u.test(expectedDigest ?? '') ||
    (await outputDigest(directory)) !== expectedDigest
  )
    throw new Error('WEB_ONLY_ARTIFACT_CHANGED');
  const required = [];
  const deadline = Date.now() + 120_000;
  const walk = async relative => {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      // Hosting directives/build manifests are upload inputs, never served resources.
      if (
        !relative &&
        ['_headers', '_redirects', '_routes.json', '_worker.js', '.vite'].includes(entry.name)
      )
        continue;
      if (entry.isDirectory()) await walk(name);
      else required.push(name);
      if (required.length > 10_000 || Date.now() > deadline)
        throw new Error('WEB_ONLY_LIVE_READBACK_BUDGET');
    }
  };
  await walk('');
  for (const mandatory of [
    'index.html',
    '.well-known/wishly/stable.json',
    '.well-known/wishly/web-release.json'
  ])
    if (!required.includes(mandatory)) throw new Error('WEB_ONLY_LIVE_BYTES_UNPROVEN');
  for (const relative of required) {
    if (Date.now() >= deadline) throw new Error('WEB_ONLY_LIVE_READBACK_BUDGET');
    const local = await readWebFile(directory, relative, 16 * 1024 * 1024);
    const served =
      relative === 'index.html'
        ? ''
        : relative.endsWith('/index.html')
          ? relative.slice(0, -10)
          : relative.endsWith('.html')
            ? relative.slice(0, -5)
            : relative;
    const pathname = `/${served.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetcher(new URL(pathname, binding.siteOrigin), {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now())))
    });
    if (!response.ok || !response.body) throw new Error('WEB_ONLY_LIVE_BYTES_UNPROVEN');
    const hash = createHash('sha256');
    let length = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > local.length) throw new Error('WEB_ONLY_LIVE_BYTES_MISMATCH');
        hash.update(value);
      }
    } finally {
      await reader.cancel();
    }
    if (length !== local.length || hash.digest('hex') !== sha256(local))
      throw new Error('WEB_ONLY_LIVE_BYTES_MISMATCH');
  }
  if ((await outputDigest(directory)) !== expectedDigest)
    throw new Error('WEB_ONLY_ARTIFACT_CHANGED');
  return { files: required.length, outputDigest: expectedDigest };
}
