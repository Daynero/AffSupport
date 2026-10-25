#!/usr/bin/env node
import { readFile, writeFile, mkdir, access, rm, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setPriority } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { atomicRecord } from './lib/release/task-store.mjs';
import { execute } from './lib/release/execute.mjs';
import { inspectWebOnlySource, newBackendMigrationPaths } from './lib/web-only-policy.mjs';
import { acquireWebReleaseLock, webReleaseStateFile } from './lib/web-only-lock.mjs';
import {
  webReleaseResources,
  assertWebReleaseResources,
  boundedWebEnvironment
} from './lib/web-only-resources.mjs';

export function webOnlyBackendPlan(args) {
  const values = args.filter(arg => arg.startsWith('--backend-plan='));
  if (values.length > 1 || values.some(value => value === '--backend-plan='))
    throw new Error('WEB_ONLY_ARGUMENT_INVALID');
  return values[0]?.slice('--backend-plan='.length) ?? null;
}
export function webOnlyMode(args) {
  const modes = [
    '--check',
    '--verify-only',
    '--deploy',
    '--report',
    '--reconcile',
    '--plan-db',
    '--reconcile-db'
  ];
  if (
    args.some(arg => !modes.includes(arg) && arg !== '--json' && !arg.startsWith('--backend-plan='))
  )
    throw new Error('WEB_ONLY_ARGUMENT_INVALID');
  const selected = args.filter(arg => modes.includes(arg));
  if (selected.length > 1) throw new Error('WEB_ONLY_ARGUMENT_INVALID');
  const plan = webOnlyBackendPlan(args);
  const mode = selected[0]?.slice(2) ?? 'check';
  if (plan && ['report', 'reconcile', 'plan-db', 'reconcile-db'].includes(mode))
    throw new Error('WEB_ONLY_ARGUMENT_INVALID');
  return mode;
}

/** Release facts come from their canonical source even before the shared seed build. */
async function agentTag(cwd) {
  const source = await readFile(path.join(cwd, 'packages/shared/src/release.ts'), 'utf8');
  const version = /export const PRODUCT_VERSION = '([0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?)';/u.exec(
    source
  )?.[1];
  if (!version) throw new Error('WEB_ONLY_RELEASE_IDENTITY_UNPROVEN');
  return `v${version}`;
}

async function assertBetaContainment(cwd) {
  const git = promisify(execFile);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const branch = process.env.BETA_BRANCH?.trim() || 'beta';
  if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/u.test(branch))
    throw new Error('WEB_ONLY_BETA_BRANCH_INVALID');
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      await git('git', ['-c', 'core.fsmonitor=false', 'merge-base', '--is-ancestor', 'HEAD', ref], {
        cwd,
        env,
        timeout: 10_000,
        maxBuffer: 8192
      });
      return;
    } catch {
      /* Try the other explicit branch namespace. */
    }
  }
  throw new Error('WEB_ONLY_BETA_CONTAINMENT_UNPROVEN');
}

export const WEB_ONLY_CHECKS = Object.freeze([
  'static',
  'releaseFinal',
  'publishedArtifacts',
  'packagedRuntime',
  'candidateBrowser'
]);

/** Unknown provider outcomes must be read back before any new release writes. */
export function assertNoPendingPublication(pending) {
  if (pending)
    throw new Error(
      'WEB_ONLY_PUBLICATION_UNRESOLVED: run release:web -- --reconcile; do not repeat upload'
    );
}
export function assertUploadProcessGone(pending) {
  const pid = pending.uploadProcess?.pid;
  if (!pid) throw new Error('WEB_ONLY_UPLOAD_QUIESCENCE_UNPROVEN');
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform === 'win32')
    throw new Error('WEB_ONLY_UPLOAD_QUIESCENCE_UNPROVEN');
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    throw new Error('WEB_ONLY_UPLOAD_QUIESCENCE_UNPROVEN', { cause: error });
  }
  throw new Error('WEB_ONLY_UPLOAD_STILL_RUNNING');
}
async function readPending(cwd) {
  return readFile(await webReleaseStateFile(cwd, 'web-publication-pending.json'), 'utf8').then(
    JSON.parse,
    error => {
      if (error.code === 'ENOENT') return null;
      throw new Error('WEB_ONLY_PENDING_RECORD_UNREADABLE');
    }
  );
}
async function persistPending(cwd, pending) {
  const file = await webReleaseStateFile(cwd, 'web-publication-pending.json');
  await atomicRecord(file, pending);
}
/** Record proven publication idempotently; preserve any independent smoke failure. */
export async function recordReconciledPublication(pending, now = new Date().toISOString()) {
  const { validateWebDeployment } = await import('./lib/release/adapters/web.mjs');
  const deployment = pending.deployment;
  const root = pending.ownerRoot;
  if (
    !path.isAbsolute(root ?? '') ||
    pending.archive !== path.join(root, 'release/automation/bundles', pending.outputDigest) ||
    deployment?.outputDigest !== pending.outputDigest ||
    deployment?.bindingDigest !== pending.bindingDigest ||
    deployment?.runId !== pending.runId ||
    !Number.isFinite(Date.parse(now))
  )
    throw new Error('WEB_ONLY_PENDING_IDENTITY_INVALID');
  validateWebDeployment({
    binding: { bindingId: deployment.bindingId },
    sourceSha: deployment.sourceSha,
    manifestSha: deployment.manifestSha,
    outputDigest: deployment.outputDigest
  });
  const reportFile = path.join(root, 'release/automation/web-only-report.json');
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  if (
    report.runId !== pending.runId ||
    report.sourceSha !== deployment.sourceSha ||
    report.outputDigest !== deployment.outputDigest
  )
    throw new Error('WEB_ONLY_PENDING_REPORT_CHANGED');
  const historyFile = path.join(root, 'release/automation/web-deployments.jsonl');
  const history = await readFile(historyFile, 'utf8').then(
    text =>
      text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)),
    error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  );
  const current = history.at(-1);
  if (
    current?.outputDigest !== deployment.outputDigest ||
    current?.sourceSha !== deployment.sourceSha ||
    current?.bindingId !== deployment.bindingId
  ) {
    const handle = await open(historyFile, 'a', 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ ...deployment, deployedAt: now, reconciledAt: now })}\n`
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  report.publicationState = 'verified';
  report.reconciledAt = now;
  report.reconciliation = { staticBytes: 'verified', liveSmoke: 'not_rechecked' };
  if (report.state !== 'completed') report.state = 'blocked';
  await atomicRecord(reportFile, report);
}

async function reconcilePublication(cwd) {
  const lock = await acquireWebReleaseLock({
    root: cwd,
    owner: 'web-only:reconcile',
    allowPending: true
  });
  try {
    const pending = await readPending(cwd);
    if (!pending) return { ok: true, mode: 'reconcile', state: 'nothing_pending' };
    assertUploadProcessGone(pending);
    const { activeBinding } = await import('./lib/release/bindings.mjs');
    const { verifyLiveWebBytes, fetchLiveManifest, assertSameUpdateChannel } =
      await import('./lib/web-only-proof.mjs');
    const { readWebFile, outputDigest } = await import('./release-web-meta.mjs');
    const binding = activeBinding();
    if (
      pending.schemaVersion !== 1 ||
      pending.bindingDigest !== binding.digest ||
      !/^[a-f0-9]{64}$/u.test(pending.outputDigest ?? '') ||
      !path.isAbsolute(pending.archive ?? '') ||
      pending.deployment?.bindingId !== binding.bindingId
    )
      throw new Error('WEB_ONLY_PENDING_IDENTITY_INVALID');
    if ((await outputDigest(pending.archive)) !== pending.outputDigest)
      throw new Error('WEB_ONLY_PENDING_ARCHIVE_CHANGED');
    assertSameUpdateChannel(
      await readWebFile(pending.archive, '.well-known/wishly/stable.json'),
      await fetchLiveManifest(binding)
    );
    await verifyLiveWebBytes({
      directory: pending.archive,
      binding,
      expectedDigest: pending.outputDigest
    });
    await recordReconciledPublication(pending);
    // Only exact live readback can clear uncertainty. A partial/different deploy stays blocked.
    await rm(await webReleaseStateFile(cwd, 'web-publication-pending.json'));
    return {
      ok: true,
      mode: 'reconcile',
      state: 'publication_verified',
      runId: pending.runId,
      outputDigest: pending.outputDigest
    };
  } finally {
    await lock.release();
  }
}

/** One trusted local writer; optional rehearsed additive SQL, no native packaging/version mutation. */
export async function runWebOnly({
  cwd = process.cwd(),
  mode = 'check',
  backendPlanPath = null
} = {}) {
  if (
    !['check', 'verify-only', 'deploy', 'report', 'reconcile', 'plan-db', 'reconcile-db'].includes(
      mode
    )
  )
    throw new Error('WEB_ONLY_ARGUMENT_INVALID');
  if (mode === 'report') {
    const report = JSON.parse(
      await readFile(path.join(cwd, 'release/automation/web-only-report.json'), 'utf8')
    );
    return { ok: true, mode, state: 'report', report };
  }
  if (mode === 'reconcile') return reconcilePublication(cwd);
  if (mode === 'reconcile-db') {
    const { activeBinding } = await import('./lib/release/bindings.mjs');
    const { reconcileMiniDbRelease } = await import('./lib/mini-db-release.mjs');
    return reconcileMiniDbRelease({ cwd, binding: activeBinding() });
  }
  if (mode !== 'check') assertNoPendingPublication(await readPending(cwd));
  const dbContext = backendPlanPath
    ? await (
        await import('./lib/mini-db-release.mjs')
      ).createMiniDbContext({ cwd, documentPath: backendPlanPath })
    : null;
  const backendPaths =
    dbContext?.backendPaths ??
    (mode === 'plan-db'
      ? await newBackendMigrationPaths({ cwd, agentRef: await agentTag(cwd) })
      : []);
  const source = await inspectWebOnlySource({ cwd, agentRef: await agentTag(cwd), backendPaths });
  if (!source.ok)
    return {
      ok: false,
      mode,
      state: 'ineligible',
      source,
      error: { code: 'WEB_ONLY_INELIGIBLE', blockers: source.blockers }
    };
  if (!source.sourceSha || !source.agentSha || !source.agentInputsDigest)
    throw new Error('WEB_ONLY_SOURCE_UNPROVEN');
  if (dbContext && dbContext.sourceSha !== source.sourceSha)
    throw new Error('DB_PLAN_SOURCE_MISMATCH');
  const resources = await webReleaseResources(cwd);
  if (mode === 'plan-db') {
    assertWebReleaseResources(resources);
    const { activeBinding } = await import('./lib/release/bindings.mjs');
    const { createMiniDbDraft, miniDbConnectionString } = await import('./lib/mini-db-plan.mjs');
    const result = await createMiniDbDraft({
      cwd,
      binding: activeBinding(),
      source,
      backendPaths,
      connectionString: miniDbConnectionString()
    });
    const after = await inspectWebOnlySource({ cwd, agentRef: await agentTag(cwd), backendPaths });
    if (!after.ok || after.sourceSha !== source.sourceSha)
      throw new Error('DB_PLAN_SOURCE_CHANGED');
    return {
      ok: true,
      mode,
      state: 'db_plan_prepared',
      sourceSha: source.sourceSha,
      planFile: result.file,
      draftDigest: result.draft.draftDigest,
      pending: result.draft.migrations.map(item => item.version),
      databaseWrites: 0
    };
  }
  if (mode === 'check') {
    const prerequisites = {};
    for (const file of [
      'release/beta/verification.json',
      'release/beta/package-provenance.json',
      '.env.beta'
    ]) {
      prerequisites[file] = await access(path.join(cwd, file)).then(
        () => 'present_unverified',
        () => 'missing'
      );
    }
    return {
      ok: true,
      mode,
      state: 'eligible_pending_verification',
      source,
      resources,
      prerequisites,
      scheduledChecks: WEB_ONLY_CHECKS,
      deploymentAuthorized: false
    };
  }
  assertWebReleaseResources(resources);
  setPriority(0, 15);
  const lock = await acquireWebReleaseLock({ root: cwd, owner: `web-only:${source.sourceSha}` });
  try {
    assertNoPendingPublication(await readPending(cwd));
  } catch (error) {
    await lock.release();
    throw error;
  }
  const runId = randomUUID();
  const stages = [];
  let published = false;
  let cleanupUnconfirmed = false;
  let pendingPublication = null;
  const reportFile = path.join(cwd, 'release/automation/web-only-report.json');
  /** @type {{schemaVersion:number,runId:string,mode:string,sourceSha:string|null,agentSha:string|null,startedAt:string,state:string,stages:Array<{id:string,ok:boolean,durationMs:number,cleanupConfirmed?:boolean}>,publicationState:string,source:string|null,webBuildId:string|null,outputDigest:string|null,error:{code:string,subject:string}|null,backend?:any}} */
  const report = {
    schemaVersion: 1,
    runId,
    mode,
    sourceSha: source.sourceSha,
    agentSha: source.agentSha,
    startedAt: new Date().toISOString(),
    state: 'verifying',
    stages,
    publicationState: 'none',
    source: source.sourceSha,
    webBuildId: null,
    outputDigest: null,
    error: null
  };
  async function persist() {
    await atomicRecord(reportFile, report);
  }
  /** @type {Record<string,string>} */
  const env = {
    ...boundedWebEnvironment(),
    SOTY_VERIFY_SERIAL: '1',
    SOTY_WEB_MANAGED_TREE: '1',
    SOTY_WEB_MANAGED_DEPTH: '0',
    SOTY_WEB_RELEASE_LOCK_TOKEN: lock.token
  };
  async function unchanged() {
    const current = await inspectWebOnlySource({
      cwd,
      agentRef: await agentTag(cwd),
      backendPaths
    });
    if (
      !current.ok ||
      current.sourceSha !== source.sourceSha ||
      current.agentSha !== source.agentSha ||
      current.agentInputsDigest !== source.agentInputsDigest
    )
      throw new Error('WEB_ONLY_SOURCE_CHANGED');
  }
  async function gate(id, argv, extraEnv = {}, timeoutMs = 900_000) {
    await unchanged();
    const sample = await webReleaseResources(cwd);
    assertWebReleaseResources(sample);
    if (id === 'static' && sample.memoryFreePercent < 25)
      throw new Error('WEB_RELEASE_WAIT_MEMORY: static compiler requires 25% headroom');
    await persist();
    const started = Date.now();
    const result = await execute(argv, {
      cwd,
      env: { ...env, ...extraEnv },
      timeoutMs,
      managedTree: true,
      onSpawn:
        id === 'deploy'
          ? identity => persistPending(cwd, { ...pendingPublication, uploadProcess: identity })
          : undefined
    });
    const nestedCleanupUnconfirmed =
      !result.ok &&
      /WEB_MANAGED_CLEANUP_UNCONFIRMED|Owned gate process-tree termination is unconfirmed/u.test(
        result.output.join('')
      );
    if (
      nestedCleanupUnconfirmed ||
      ('cleanupConfirmed' in result && result.cleanupConfirmed === false)
    )
      cleanupUnconfirmed = true;
    stages.push({
      id,
      ok: result.ok,
      durationMs: Date.now() - started,
      ...('cleanupConfirmed' in result
        ? { cleanupConfirmed: result.cleanupConfirmed && !nestedCleanupUnconfirmed }
        : {})
    });
    await persist();
    if (nestedCleanupUnconfirmed)
      throw new Error(
        `WEB_ONLY_CLEANUP_UNCONFIRMED: ${id}: ${result.output.join('').match(/WEB_MANAGED_CLEANUP_UNCONFIRMED[^\n]*/u)?.[0] ?? 'owned detached gate termination unconfirmed; writer lock retained'}`
      );
    if (!result.ok)
      throw new Error(
        `WEB_ONLY_GATE_FAILED: ${id}: ${'error' in result ? result.error : ''}: ${result.output.slice(-3).join(' ').slice(-800)}`
      );
    await unchanged();
  }
  async function localGate(id, action) {
    await unchanged();
    assertWebReleaseResources(await webReleaseResources(cwd));
    const started = Date.now();
    try {
      const result = await action();
      stages.push({ id, ok: true, durationMs: Date.now() - started });
      await persist();
      await unchanged();
      return result;
    } catch (error) {
      stages.push({ id, ok: false, durationMs: Date.now() - started });
      await persist();
      throw error;
    }
  }
  try {
    await persist();
    await assertBetaContainment(cwd);
    // Consumers below dynamically load shared only after the canonical seed rebuild.
    await gate(
      'shared-seed',
      ['npm', 'run', 'build', '-w', '@video-compressor/shared'],
      {},
      180_000
    );
    const { activeBinding } = await import('./lib/release/bindings.mjs');
    const { outputDigest } = await import('./release-web-meta.mjs');
    const {
      MANIFEST_PATH,
      PROOF_PATH,
      webConfiguration,
      inspectPackagedBeta,
      assertSameUpdateChannel,
      fetchLiveManifest,
      packagePayloadDigest,
      writeWebOnlyProof,
      assertStoredWebOnlyProof
    } = await import('./lib/web-only-proof.mjs');
    const binding = activeBinding();
    const configuration = webConfiguration(cwd);
    const manifest = await readFile(path.join(cwd, MANIFEST_PATH));
    const manifestDigest = assertSameUpdateChannel(manifest, await fetchLiveManifest(binding));
    if (mode === 'deploy' && binding.kind === 'production') {
      const { validateProductionActivation } = await import('./lib/release/activation.mjs');
      await validateProductionActivation(path.join(cwd, 'release/automation'), cwd);
    }
    if (dbContext) report.backend = await dbContext.prepare({ binding, gate });
    let proof = null;
    const saved = await readFile(path.join(cwd, PROOF_PATH), 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return null;
      throw new Error('WEB_ONLY_PROOF_UNREADABLE');
    });
    if (
      mode === 'deploy' &&
      saved &&
      saved.sourceSha === source.sourceSha &&
      saved.configurationDigest === configuration.digest &&
      Boolean(saved.backend) === Boolean(dbContext) &&
      (!dbContext || saved.backend.draftDigest === dbContext.draftDigest) &&
      Date.now() - Date.parse(saved.verifiedAt) <= 30 * 60_000
    ) {
      // A changed artifact/package is a refusal, never a reason to silently re-attest it.
      proof = await assertStoredWebOnlyProof({ cwd, binding, backendPhase: 'candidate' });
      if (dbContext) await dbContext.adoptProof(proof.backend);
    }
    if (!proof) {
      const packaged = await inspectPackagedBeta(cwd, { backendPaths });
      const beta = webConfiguration(cwd, 'beta').values;
      const rawBeta = await readFile(path.join(cwd, '.env.beta'), 'utf8');
      const origin = /^PUBLIC_SITE_ORIGIN=(.+)$/mu.exec(rawBeta)?.[1]?.trim();
      const betaBackend = new URL(beta.VITE_SUPABASE_URL ?? 'invalid');
      if (
        !origin ||
        betaBackend.protocol !== 'http:' ||
        betaBackend.hostname !== '127.0.0.1' ||
        !['54321', '54329'].includes(betaBackend.port)
      )
        throw new Error('WEB_ONLY_BETA_CONFIG_INVALID');
      if (dbContext) await dbContext.verifyBeta(beta);
      const { BETA_PROFILE } = await import('../packages/shared/dist/environment.js');
      const webBuildId = `web:${source.sourceSha}:${configuration.digest.slice(0, 12)}`;
      report.webBuildId = webBuildId;
      const betaDirectory = path.join(cwd, 'release/web-only', source.sourceSha, 'beta');
      const betaEnv = {
        NODE_ENV: 'production',
        ...beta,
        VITE_APP_ENVIRONMENT: 'beta',
        VITE_SITE_URL: origin,
        VITE_AGENT_URL: `http://127.0.0.1:${BETA_PROFILE.agentPort}`,
        VITE_LOCAL_DEV_AUTH: 'false',
        VITE_ANALYTICS_ENABLED: 'false',
        VITE_WEB_BUILD_ID: `${webBuildId}:beta`,
        VITE_WEB_REVISION: source.sourceSha
      };
      await gate(
        'static',
        ['npm', 'run', 'verify'],
        { NODE_OPTIONS: `${env.NODE_OPTIONS} --max-old-space-size=2048` },
        2_700_000
      );
      await gate('csp', ['npm', 'run', 'generate:csp']);
      await gate(
        'beta-web',
        [
          'npm',
          'run',
          'build',
          '-w',
          '@video-compressor/web',
          '--',
          '--mode',
          'beta',
          '--outDir',
          betaDirectory
        ],
        betaEnv
      );
      const betaBundleDigest = await outputDigest(betaDirectory);
      await gate('production-web', ['npm', 'run', 'build:web'], {
        NODE_ENV: 'production',
        ...configuration.values,
        VITE_WEB_BUILD_ID: webBuildId,
        VITE_WEB_REVISION: source.sourceSha
      });
      const metadataDirectory = path.join(cwd, 'apps/web/dist/.well-known/wishly');
      await mkdir(metadataDirectory, { recursive: true });
      await writeFile(
        path.join(metadataDirectory, 'web-release.json'),
        JSON.stringify({
          schemaVersion: 1,
          sourceSha: source.sourceSha,
          webBuildId,
          configurationDigest: configuration.digest
        })
      );
      const productionBundleDigest = await outputDigest(path.join(cwd, 'apps/web/dist'));
      await gate('web-environment', [process.execPath, 'scripts/verify-web-env.mjs']);
      await gate('team-production', ['npm', 'run', 'verify:team-production']);
      await gate('releaseFinal', [process.execPath, 'scripts/verify-release.mjs', '--mode=final']);
      await gate('publishedArtifacts', [process.execPath, 'scripts/verify-published-release.mjs']);
      const runtimeReceipt = path.join(cwd, 'release/automation', `web-runtime-${runId}.json`);
      await rm(runtimeReceipt, { force: true });
      if (dbContext) await dbContext.verifyBeta(beta);
      await gate(
        'packagedRuntime',
        [
          process.execPath,
          'scripts/verify-beta-runtime.mjs',
          `--web-only-bundle=${betaDirectory}`,
          `--web-only-digest=${betaBundleDigest}`,
          `--web-only-package-source=${packaged.sourceSha}`,
          `--web-only-source=${source.sourceSha}`,
          `--web-only-receipt=${runtimeReceipt}`
        ],
        {},
        300_000
      );
      const runtimeResult = JSON.parse(await readFile(runtimeReceipt, 'utf8'));
      if (
        runtimeResult.schemaVersion !== 1 ||
        runtimeResult.sourceSha !== source.sourceSha ||
        runtimeResult.packageSourceSha !== packaged.sourceSha ||
        runtimeResult.betaBundleDigest !== betaBundleDigest ||
        runtimeResult.authenticated !== true ||
        runtimeResult.visibleCompletedJob !== true ||
        runtimeResult.exactStaticBytes !== true ||
        !Number.isFinite(Date.parse(runtimeResult.completedAt)) ||
        Date.parse(runtimeResult.completedAt) < Date.parse(report.startedAt) ||
        Date.parse(runtimeResult.completedAt) > Date.now() + 60_000
      )
        throw new Error('WEB_ONLY_RUNTIME_EVIDENCE_UNPROVEN');
      if (
        (await packagePayloadDigest(packaged.directory)) !== packaged.payloadDigest ||
        webConfiguration(cwd).digest !== configuration.digest ||
        (await outputDigest(path.join(cwd, 'apps/web/dist'))) !== productionBundleDigest ||
        (await outputDigest(betaDirectory)) !== betaBundleDigest
      )
        throw new Error('WEB_ONLY_VERIFIED_INPUT_CHANGED');
      assertSameUpdateChannel(manifest, await fetchLiveManifest(binding));
      if (dbContext) await dbContext.verifyBeta(beta);
      const backend = dbContext?.proof();
      proof = {
        ...(backend
          ? {
              backend,
              backendDigest: (await import('./lib/web-only-proof.mjs')).valueDigest(backend)
            }
          : {}),
        schemaVersion: 1,
        kind: 'web-only',
        runId,
        sourceSha: source.sourceSha,
        agentSha: source.agentSha,
        agentInputsDigest: source.agentInputsDigest,
        bindingDigest: binding.digest,
        configurationDigest: configuration.digest,
        manifestDigest,
        webBuildId,
        productionBundleDigest,
        betaBundleDigest,
        packageDigest: packaged.payloadDigest,
        packageSourceSha: packaged.sourceSha,
        packageBaselineDigest: packaged.baselineDigest,
        verifiedAt: new Date().toISOString(),
        checks: Object.fromEntries(WEB_ONLY_CHECKS.map(id => [id, 'passed']))
      };
      await writeWebOnlyProof(cwd, proof);
    }
    report.webBuildId = proof.webBuildId;
    report.outputDigest = proof.productionBundleDigest;
    await assertStoredWebOnlyProof({ cwd, binding, backendPhase: 'candidate' });
    if (mode === 'verify-only') {
      report.state = dbContext ? 'verified_db_prepared' : 'verified';
      if (dbContext) report.backend = { ...report.backend, state: 'prepared' };
      await persist();
      return { ok: true, ...report };
    }
    if (dbContext) {
      const backend = await localGate('db-apply', async () => {
        const activated = await dbContext.activate();
        report.backend = { ...report.backend, state: 'applied' };
        await persist();
        return activated;
      });
      proof = {
        ...proof,
        backend,
        backendDigest: (await import('./lib/web-only-proof.mjs')).valueDigest(backend)
      };
      await writeWebOnlyProof(cwd, proof);
    }
    await assertStoredWebOnlyProof({ cwd, binding });
    await gate('beta-promotion', [
      process.execPath,
      'scripts/verify-beta-promotion.mjs',
      '--web-only'
    ]);
    await gate('published-artifacts-fresh', [
      process.execPath,
      'scripts/verify-published-release.mjs'
    ]);
    report.state = 'publishing';
    report.publicationState = 'unknown';
    await persist();
    const { deploymentIdentity } = await import('./deploy-web.mjs');
    pendingPublication = {
      schemaVersion: 1,
      ownerRoot: cwd,
      deployment: {
        schemaVersion: 1,
        bindingId: binding.bindingId,
        bindingDigest: binding.digest,
        ...deploymentIdentity(cwd),
        outputDigest: proof.productionBundleDigest,
        manifestDigest: proof.manifestDigest,
        webBuildId: proof.webBuildId,
        kind: 'web-only',
        runId
      },
      runId,
      bindingDigest: binding.digest,
      outputDigest: proof.productionBundleDigest,
      archive: path.join(cwd, 'release/automation/bundles', proof.productionBundleDigest),
      uploadProcess: null
    };
    await persistPending(cwd, pendingPublication);
    await gate('deploy', [process.execPath, 'scripts/deploy-web.mjs', '--web-only']);
    published = true;
    report.publicationState = 'published_unverified';
    await persist();
    await gate('live-smoke', [process.execPath, 'scripts/verify-live-smoke.mjs']);
    assertSameUpdateChannel(manifest, await fetchLiveManifest(binding));
    // Static byte readback is independent of upload's exit code.
    const { verifyLiveWebBytes } = await import('./lib/web-only-proof.mjs');
    await verifyLiveWebBytes({
      directory: path.join(cwd, 'apps/web/dist'),
      binding,
      expectedDigest: proof.productionBundleDigest
    });
    await rm(await webReleaseStateFile(cwd, 'web-publication-pending.json'));
    report.state = 'completed';
    report.publicationState = 'verified';
    await persist();
    return { ok: true, ...report };
  } catch (error) {
    report.state = 'blocked';
    if (dbContext && error instanceof Error && 'dbOutcome' in error) {
      report.backend = { ...report.backend, state: error.dbOutcome };
    } else if (dbContext && stages.some(stage => stage.id === 'db-apply' && !stage.ok)) {
      const pending = await readFile(
        await webReleaseStateFile(cwd, 'mini-db-pending.json'),
        'utf8'
      ).then(
        () => true,
        failure => failure.code !== 'ENOENT'
      );
      report.backend = { ...report.backend, state: pending ? 'unknown' : 'not_applied' };
    }
    report.error = {
      code: error instanceof Error ? error.message.split(':')[0] : 'WEB_ONLY_FAILED',
      subject: error instanceof Error ? error.message.slice(0, 1200) : 'WEB_ONLY_FAILED'
    };
    if (published) report.publicationState = 'published_unverified';
    await persist();
    return { ok: false, ...report };
  } finally {
    if (!cleanupUnconfirmed) await lock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const result = await runWebOnly({
      mode: webOnlyMode(args),
      backendPlanPath: webOnlyBackendPlan(args)
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: error instanceof Error ? error.message.split(':')[0] : 'WEB_ONLY_FAILED' } })}\n`
    );
    process.exitCode = 1;
  }
}
