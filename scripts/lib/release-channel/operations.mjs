/**
 * Feature 051 operations: record a candidate on `next`, promote exactly those
 * bytes, roll production back, cancel a candidate, adopt what production serves
 * today, and say where everything stands.
 *
 * Nothing here rebuilds. Every bundle that reaches an origin comes from the
 * channel archive, is proven to still hash to its name, carries a signed
 * manifest that verifies, and is read back from the live origin before the state
 * says it is there. Writes to production happen only with `confirm`.
 */
import { spawnSync } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { acquireWebReleaseLock } from '../web-only-lock.mjs';
import { liveIdentity } from './live.mjs';
import {
  appendHistory,
  archiveBundle,
  archivedBundle,
  ChannelError,
  channelDirectory,
  describeBundle,
  INDEX_PATH,
  MANIFEST_PATH,
  PREVIOUS_KEPT,
  pruneBundles,
  readState,
  sha256,
  writeState
} from './state.mjs';
import { readWebFile } from '../../release-web-meta.mjs';

export const WRANGLER = 'wrangler@4.112.0';
export const PRODUCTION_BRANCH = 'main';

/** The default uploader: the pinned wrangler, no shell, output to the terminal. */
export function wranglerUpload({ directory, project, branch }) {
  return spawnSync(
    'npx',
    [
      '--yes',
      WRANGLER,
      'pages',
      'deploy',
      directory,
      '--project-name',
      project,
      '--branch',
      branch
    ],
    { shell: false, stdio: 'inherit' }
  );
}

/** The default post-promotion smoke: the same live smoke the runner uses. */
export function liveSmoke({ root, channel }) {
  const result = spawnSync(
    process.execPath,
    // The channel already proved the manifest byte for byte; the checkout this
    // runs from may be on another commit, so only the served copy is judged.
    [
      'scripts/verify-live-smoke.mjs',
      '--served-only',
      ...(channel === 'next' ? ['--channel=next'] : [])
    ],
    { cwd: root, shell: false, stdio: 'inherit' }
  );
  return { ok: result.status === 0 };
}

/**
 * @param {{
 *   root?: string, dir?: string, binding: any, env?: NodeJS.ProcessEnv,
 *   upload?: typeof wranglerUpload, fetcher?: typeof fetch, now?: () => string,
 *   sleep?: (ms: number) => Promise<void>, smoke?: typeof liveSmoke,
 *   publicKeySpki?: string, liveAttempts?: number, liveDelayMs?: number
 * }} options
 */
export async function channelContext(options) {
  const root = options.root ?? process.cwd();
  const binding = options.binding;
  if (!binding?.previewSiteOrigin || !binding?.previewBranch)
    throw new ChannelError(
      'CHANNEL_UNSUPPORTED_TARGET',
      `${binding?.bindingId ?? 'this target'} has no preview address`
    );
  return {
    root,
    binding,
    dir: options.dir ?? (await channelDirectory(root, options.env)),
    upload: options.upload ?? wranglerUpload,
    fetcher: options.fetcher ?? fetch,
    now: options.now ?? (() => new Date().toISOString()),
    sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    smoke: options.smoke ?? liveSmoke,
    publicKeySpki: options.publicKeySpki,
    liveAttempts: options.liveAttempts ?? 36,
    liveDelayMs: options.liveDelayMs ?? 5000
  };
}

/** @param {any} ctx @param {'next'|'production'} channel */
function originOf(ctx, channel) {
  return channel === 'next' ? ctx.binding.previewSiteOrigin : ctx.binding.siteOrigin;
}

/** @param {any} ctx @param {'next'|'production'} channel */
function branchOf(ctx, channel) {
  return channel === 'next' ? ctx.binding.previewBranch : PRODUCTION_BRANCH;
}

/** Live bytes compared with a record; `null` when the origin is unreachable. */
async function liveMatches(ctx, channel, record) {
  try {
    const live = await liveIdentity(originOf(ctx, channel), ctx.fetcher);
    return (
      sha256(live.index) === record.indexDigest && sha256(live.manifest) === record.manifestDigest
    );
  } catch (error) {
    if (error instanceof ChannelError && error.code === 'CHANNEL_LIVE_UNREACHABLE') return null;
    throw error;
  }
}

/** Waits for Cloudflare to serve the record's bytes at an origin. */
async function waitForLive(ctx, channel, record) {
  for (let attempt = 0; attempt < ctx.liveAttempts; attempt += 1) {
    if (await liveMatches(ctx, channel, record)) return true;
    if (attempt < ctx.liveAttempts - 1) await ctx.sleep(ctx.liveDelayMs);
  }
  return false;
}

/**
 * Uploads an archived bundle to one channel and proves it is being served.
 * Failure after the upload started is `uncertain`: the provider may have
 * accepted it, so the caller reports rather than guesses.
 */
async function deployArchived(ctx, channel, record) {
  const directory = await archivedBundle(ctx.dir, record);
  // The bundle that leaves must still be the one that was described.
  const described = await describeBundle(directory, { publicKeySpki: ctx.publicKeySpki });
  if (
    described.indexDigest !== record.indexDigest ||
    described.manifestDigest !== record.manifestDigest
  )
    throw new ChannelError(
      'CHANNEL_ARCHIVE_CHANGED',
      'archived bundle no longer matches its record'
    );
  const result = await ctx.upload({
    directory,
    project: ctx.binding.cloudflareProject,
    branch: branchOf(ctx, channel)
  });
  if (result?.status !== 0)
    throw new ChannelError(
      'CHANNEL_DEPLOY_FAILED',
      `upload to ${originOf(ctx, channel)} did not confirm success; nothing was recorded`
    );
  if (!(await waitForLive(ctx, channel, record)))
    throw new ChannelError(
      'CHANNEL_LIVE_MISMATCH',
      `${originOf(ctx, channel)} does not serve ${record.version} yet; run status again in a minute`
    );
}

async function withLock(ctx, owner, work) {
  const lock = await acquireWebReleaseLock({ root: ctx.root, owner });
  try {
    return await work(lock);
  } finally {
    await lock.release();
  }
}

/**
 * Called by deploy-web after a successful upload to `next`.
 *
 * @param {any} options
 * @param {{directory: string, sourceSha: string, manifestSha?: string|null, kind: 'full'|'web-only'}} build
 */
export async function recordNextPublication(options, build) {
  const ctx = await channelContext(options);
  const described = await describeBundle(build.directory, { publicKeySpki: ctx.publicKeySpki });
  await archiveBundle(ctx.dir, build.directory, described.outputDigest);
  const state = await readState(ctx.dir);
  const record = {
    ...described,
    sourceSha: build.sourceSha,
    manifestSha: build.manifestSha ?? null,
    deployedAt: ctx.now(),
    kind: build.kind
  };
  const previous = state.next?.status === 'testing' ? state.next : null;
  state.next = {
    status: 'testing',
    build: record,
    builds: previous ? previous.builds + 1 : 1,
    startedAt: previous ? previous.startedAt : record.deployedAt
  };
  await writeState(ctx.dir, state);
  await appendHistory(ctx.dir, { op: 'publish', at: record.deployedAt, to: record, result: 'ok' });
  await pruneBundles(ctx.dir, state);
  return state;
}

/** @param {any} options @param {{confirm?: boolean}} [flags] */
export async function promote(options, { confirm = false } = {}) {
  const ctx = await channelContext(options);
  const run = async () => {
    const state = await readState(ctx.dir);
    if (state.next?.status !== 'testing')
      throw new ChannelError('CHANNEL_NO_CANDIDATE', 'nothing is being tested on next');
    const candidate = state.next.build;
    await archivedBundle(ctx.dir, candidate);
    const onNext = await liveMatches(ctx, 'next', candidate);
    if (onNext === null)
      throw new ChannelError('CHANNEL_LIVE_UNREACHABLE', `${originOf(ctx, 'next')} did not answer`);
    if (!onNext)
      throw new ChannelError(
        'CHANNEL_NEXT_DRIFTED',
        'next no longer serves the recorded candidate; publish it again before promoting'
      );
    // The build a rollback returns to must be what production serves now. A
    // release shipped some other way (before 051, or by hand) leaves the record
    // stale, and promoting over it would make "rollback" restore the wrong bytes.
    if (state.production && (await liveMatches(ctx, 'production', state.production)) !== true)
      throw new ChannelError(
        'CHANNEL_PRODUCTION_DRIFTED',
        `${ctx.binding.siteOrigin} does not serve the recorded production ${state.production.version}; run adopt-live --confirm first`
      );
    const plan = {
      from: state.production,
      to: candidate,
      summary: `Розкатати ${candidate.version} (збірка ${candidate.buildId}) на ${ctx.binding.siteOrigin}`
    };
    if (!confirm) return { confirmed: false, ...plan, state };
    const at = ctx.now();
    try {
      await deployArchived(ctx, 'production', candidate);
    } catch (error) {
      await appendHistory(ctx.dir, {
        op: 'promote',
        at,
        to: candidate,
        result:
          error instanceof ChannelError && error.code === 'CHANNEL_DEPLOY_FAILED'
            ? 'failed'
            : 'uncertain',
        code: /** @type {any} */ (error).code ?? null
      });
      throw error;
    }
    const promoted = { ...candidate, deployedAt: at };
    if (state.production && state.production.outputDigest !== promoted.outputDigest)
      state.previous = [state.production, ...state.previous].slice(0, PREVIOUS_KEPT);
    state.production = promoted;
    state.next = { ...state.next, status: 'promoted' };
    await writeState(ctx.dir, state);
    await appendHistory(ctx.dir, {
      op: 'promote',
      at,
      from: plan.from,
      to: promoted,
      result: 'ok'
    });
    await pruneBundles(ctx.dir, state);
    const smoke = await ctx.smoke({ root: ctx.root, channel: 'production' });
    return { confirmed: true, ...plan, state, smoke };
  };
  return confirm ? withLock(ctx, 'release-channel-promote', run) : run();
}

/** @param {any} options @param {{confirm?: boolean}} [flags] */
export async function rollback(options, { confirm = false } = {}) {
  const ctx = await channelContext(options);
  const run = async () => {
    const state = await readState(ctx.dir);
    const target = state.previous[0];
    if (!state.production || !target)
      throw new ChannelError(
        'CHANNEL_NO_PREVIOUS',
        'there is no earlier production build recorded to return to'
      );
    await archivedBundle(ctx.dir, target);
    const plan = {
      from: state.production,
      to: target,
      summary: `Повернути ${ctx.binding.siteOrigin} з ${state.production.version} на ${target.version}`
    };
    if (!confirm) return { confirmed: false, ...plan, state };
    const at = ctx.now();
    try {
      await deployArchived(ctx, 'production', target);
    } catch (error) {
      await appendHistory(ctx.dir, {
        op: 'rollback',
        at,
        to: target,
        result:
          /** @type {any} */ (error).code === 'CHANNEL_DEPLOY_FAILED' ? 'failed' : 'uncertain',
        code: /** @type {any} */ (error).code ?? null
      });
      throw error;
    }
    const from = state.production;
    state.production = { ...target, deployedAt: at };
    state.previous = state.previous.slice(1);
    await writeState(ctx.dir, state);
    await appendHistory(ctx.dir, { op: 'rollback', at, from, to: state.production, result: 'ok' });
    const smoke = await ctx.smoke({ root: ctx.root, channel: 'production' });
    return { confirmed: true, ...plan, state, smoke };
  };
  return confirm ? withLock(ctx, 'release-channel-rollback', run) : run();
}

/** @param {any} options @param {{confirm?: boolean}} [flags] */
export async function cancel(options, { confirm = false } = {}) {
  const ctx = await channelContext(options);
  const run = async () => {
    const state = await readState(ctx.dir);
    if (state.next?.status !== 'testing')
      throw new ChannelError('CHANNEL_NO_CANDIDATE', 'nothing is being tested on next');
    if (!state.production)
      throw new ChannelError(
        'CHANNEL_NO_PRODUCTION',
        'production is not recorded yet; run adopt-live first so next has something to return to'
      );
    await archivedBundle(ctx.dir, state.production);
    const plan = {
      from: state.next.build,
      to: state.production,
      summary: `Скасувати ${state.next.build.version} і показати на ${ctx.binding.previewSiteOrigin} поточний прод ${state.production.version}`
    };
    if (!confirm) return { confirmed: false, ...plan, state };
    const at = ctx.now();
    await deployArchived(ctx, 'next', state.production);
    state.next = { ...state.next, status: 'cancelled' };
    await writeState(ctx.dir, state);
    await appendHistory(ctx.dir, { op: 'cancel', at, from: plan.from, to: plan.to, result: 'ok' });
    return { confirmed: true, ...plan, state };
  };
  return confirm ? withLock(ctx, 'release-channel-cancel', run) : run();
}

/**
 * Finds, among bundles archived anywhere on this machine, the one production is
 * serving right now, and records it as production. This is how the first
 * promotion gets something to roll back to.
 *
 * @param {any} options @param {{confirm?: boolean, search?: string[]}} [flags]
 */
export async function adoptLive(options, { confirm = false, search = [] } = {}) {
  const ctx = await channelContext(options);
  const live = await liveIdentity(ctx.binding.siteOrigin, ctx.fetcher);
  const wantIndex = sha256(live.index);
  const wantManifest = sha256(live.manifest);
  const candidates = [];
  for (const root of search) {
    if (
      await stat(path.join(root, INDEX_PATH)).then(
        () => true,
        () => false
      )
    ) {
      candidates.push(root);
      continue;
    }
    const entries = await readdir(root).catch(() => []);
    for (const name of entries) {
      const directory = path.join(root, name);
      if (
        !(await stat(directory).then(
          info => info.isDirectory(),
          () => false
        ))
      )
        continue;
      candidates.push(directory);
    }
  }
  for (const directory of candidates) {
    let index;
    let manifest;
    try {
      index = await readWebFile(directory, INDEX_PATH, 2 * 1024 * 1024);
      manifest = await readWebFile(directory, MANIFEST_PATH);
    } catch {
      continue;
    }
    if (sha256(index) !== wantIndex || sha256(manifest) !== wantManifest) continue;
    const described = await describeBundle(directory, { publicKeySpki: ctx.publicKeySpki });
    const record = {
      ...described,
      sourceSha: null,
      manifestSha: null,
      deployedAt: ctx.now(),
      kind: /** @type {const} */ ('adopted')
    };
    if (!confirm) return { confirmed: false, found: directory, record };
    return withLock(ctx, 'release-channel-adopt', async () => {
      await archiveBundle(ctx.dir, directory, record.outputDigest);
      const state = await readState(ctx.dir);
      if (state.production && state.production.outputDigest !== record.outputDigest)
        state.previous = [state.production, ...state.previous].slice(0, PREVIOUS_KEPT);
      state.production = record;
      await writeState(ctx.dir, state);
      await appendHistory(ctx.dir, {
        op: 'adopt',
        at: record.deployedAt,
        to: record,
        result: 'ok'
      });
      return { confirmed: true, found: directory, record, state };
    });
  }
  throw new ChannelError(
    'CHANNEL_LIVE_UNMATCHED',
    `none of ${candidates.length} archived bundles is what ${ctx.binding.siteOrigin} serves`
  );
}

/** @param {any} options */
export async function status(options) {
  const ctx = await channelContext(options);
  const state = await readState(ctx.dir);
  const [onNext, onProduction] = await Promise.all([
    state.next
      ? liveMatches(
          ctx,
          'next',
          state.next.status === 'cancelled' && state.production
            ? state.production
            : state.next.build
        )
      : null,
    state.production ? liveMatches(ctx, 'production', state.production) : null
  ]);
  return {
    state,
    live: { next: onNext, production: onProduction },
    origins: { next: originOf(ctx, 'next'), production: originOf(ctx, 'production') }
  };
}

/** Plain-language summary for the owner. @param {Awaited<ReturnType<typeof status>>} report */
export function describeStatus(report) {
  const { state, live, origins } = report;
  const lines = [];
  const name = (/** @type {any} */ r) =>
    `${r.version} (збірка ${r.buildId}, ${r.kind === 'adopted' ? 'записано' : 'викладено'} ${r.deployedAt.slice(0, 16).replace('T', ' ')} UTC)`;
  lines.push(
    state.production
      ? `Прод ${origins.production}: ${name(state.production)}${live.production === false ? ' — УВАГА: сайт зараз віддає щось інше' : live.production === null ? ' — сайт не відповів' : ''}`
      : `Прод ${origins.production}: ще не записаний (потрібен adopt-live)`
  );
  if (!state.next) lines.push(`Тест ${origins.next}: кандидата немає`);
  else if (state.next.status === 'testing')
    lines.push(
      `Тест ${origins.next}: ${name(state.next.build)}, збірка №${state.next.builds} цього кандидата${live.next === false ? ' — УВАГА: next віддає щось інше' : live.next === null ? ' — next не відповів' : ''}`
    );
  else
    lines.push(
      `Тест ${origins.next}: останній кандидат ${state.next.build.version} — ${state.next.status === 'promoted' ? 'розкочено' : 'скасовано'}`
    );
  lines.push(
    state.previous[0]
      ? `Відкат поверне: ${name(state.previous[0])}`
      : 'Відкат: немає попередньої версії'
  );
  return lines.join('\n');
}
