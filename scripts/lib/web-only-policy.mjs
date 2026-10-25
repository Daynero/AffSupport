import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ROOT_PACKAGE = 'package.json';
const STABLE_MANIFEST = 'apps/web/public/.well-known/wishly/stable.json';
const OPERATOR_SCRIPTS = Object.freeze({
  'release:web': 'node scripts/release-web-only.mjs',
  'beta:verify:web': 'node scripts/verify-web-only.mjs'
});

// This is the reviewed MVP's infrastructure boundary, not a general scripts/
// exception. The beta packager is enrolled only for the reviewed payload-seal
// producer; other packaging/runtime/dependency scripts remain protected.
const REVIEWED_INFRASTRUCTURE = new Set([
  'scripts/release-web-only.mjs',
  'scripts/lib/mini-db-policy.mjs',
  'scripts/lib/mini-db-plan.mjs',
  'scripts/lib/mini-db-release.mjs',
  'scripts/lib/mini-db-transaction.mjs',
  'scripts/lib/mini-db-writer-lock.mjs',
  'scripts/lib/mini-db-rehearsal.mjs',
  'scripts/test-mini-db-isolated.mjs',
  'scripts/test-mini-db-self.mjs',
  'scripts/apply-backend-plan.mjs',
  'scripts/lib/release/step-adapter.mjs',
  'scripts/verify-web-only.mjs',
  'scripts/lib/web-only-proof.mjs',
  'scripts/lib/web-only-lock.mjs',
  'scripts/lib/web-only-resources.mjs',
  'scripts/lib/web-only-runtime.mjs',
  'scripts/lib/web-only-policy.mjs',
  'scripts/lib/release/execute.mjs',
  'scripts/lib/gate.mjs',
  'scripts/verify-beta-promotion.mjs',
  'scripts/verify-beta-package.sh',
  'scripts/package-beta-mac.sh',
  'scripts/beta-package-provenance.mjs',
  'scripts/verify-beta-runtime.mjs',
  'scripts/lib/web-rollback.mjs',
  'scripts/rollback-web.mjs',
  'scripts/deploy-web.mjs',
  'scripts/release-web-meta.mjs'
]);
const DOCUMENTS = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'RELEASE_NOTES.md',
  'ROLLBACK.md',
  'TESTER_GUIDE.md'
]);
const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock)$/u;
const BETA_PACKAGER = 'scripts/package-beta-mac.sh';
// This exact three-line addition records payload provenance after packaging.
// Nothing that compiles, stages, signs or configures the package is exempt.
const BETA_PROVENANCE_ADDITION =
  '# Seal the actual package payload before any verification record can attest it.\n' +
  'node "${0:A:h}/beta-package-provenance.mjs" --record >/dev/null\n\n';

/** @typedef {{path: string, code: string}} WebOnlyBlocker */

function validPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  );
}

function backendPathSet(paths) {
  if (
    !Array.isArray(paths) ||
    paths.some(
      name =>
        typeof name !== 'string' ||
        !/^supabase\/migrations\/[0-9]{14}_[a-z][a-z0-9_]*\.sql$/u.test(name)
    )
  )
    throw new Error('DB_BACKEND_PATH_INVALID');
  return new Set(paths);
}

function pathDecision(name, backendPaths = new Set()) {
  if (!validPath(name)) return 'WEB_ONLY_PATH_INVALID';
  if (name === ROOT_PACKAGE || name === STABLE_MANIFEST || backendPaths.has(name)) return null;
  if (
    name.startsWith('apps/web/public/') &&
    /\/(?:_worker\.js|_routes\.json|_redirects|_headers)(?:\/|$)/iu.test(name)
  )
    return 'WEB_ONLY_HOSTING_INPUT_CHANGED';
  if (
    LOCKFILE.test(name) ||
    /^(?:apps\/agent|packages|packaging|config|supabase)(?:\/|$)/u.test(name) ||
    /^apps\/web\/(?:package\.json|vite\.[^/]+|tsconfig[^/]*|\.env[^/]*)$/u.test(name)
  )
    return 'WEB_ONLY_AGENT_INPUT_CHANGED';
  if (
    name.startsWith('apps/web/src/') ||
    name.startsWith('apps/web/public/') ||
    name.startsWith('docs/') ||
    name.startsWith('tests/') ||
    name.startsWith('specs/') ||
    name.startsWith('.specify/') ||
    DOCUMENTS.has(name) ||
    REVIEWED_INFRASTRUCTURE.has(name)
  )
    return null;
  if (name.startsWith('scripts/')) return 'WEB_ONLY_AGENT_INPUT_CHANGED';
  return 'WEB_ONLY_PATH_UNKNOWN';
}

/**
 * Path classification only. package.json needs Git-blob comparison, and the
 * signed update manifest additionally needs an independent live-byte check.
 * An allowed path is never proof of either condition.
 * @param {readonly string[]} paths
 * @param {{backendPaths?: string[]}} [options]
 * @returns {{ok: boolean, blockers: WebOnlyBlocker[]}}
 */
export function assessWebOnlyChanges(paths, { backendPaths = [] } = {}) {
  let backend;
  try {
    backend = backendPathSet(backendPaths);
  } catch {
    return { ok: false, blockers: [{ path: '[backend]', code: 'DB_BACKEND_PATH_INVALID' }] };
  }
  if (!Array.isArray(paths))
    return { ok: false, blockers: [{ path: '[paths]', code: 'WEB_ONLY_PATHS_INVALID' }] };
  if (paths.some(name => typeof name !== 'string'))
    return { ok: false, blockers: [{ path: '[path]', code: 'WEB_ONLY_PATH_INVALID' }] };
  const blockers = [];
  for (const name of [...new Set(paths)].sort()) {
    const code = pathDecision(name, backend);
    if (code) blockers.push({ path: typeof name === 'string' ? name : '[path]', code });
  }
  return { ok: blockers.length === 0, blockers };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePackage(text) {
  /** @type {unknown} */
  const value = JSON.parse(text);
  if (!record(value) || !record(value.scripts)) throw new Error('package metadata invalid');
  return value;
}

function normalizedPackage(value) {
  if (!record(value.scripts)) throw new Error('package scripts invalid');
  return {
    ...value,
    scripts: Object.fromEntries(
      Object.entries(value.scripts).filter(([key]) => !Object.hasOwn(OPERATOR_SCRIPTS, key))
    )
  };
}

function packageCompatible(before, after) {
  if (!record(before.scripts) || !record(after.scripts)) return false;
  if (canonical(normalizedPackage(before)) !== canonical(normalizedPackage(after))) return false;
  for (const [key, expected] of Object.entries(OPERATOR_SCRIPTS)) {
    if (Object.hasOwn(before.scripts, key)) {
      if (after.scripts[key] !== before.scripts[key]) return false;
    } else if (Object.hasOwn(after.scripts, key) && after.scripts[key] !== expected) return false;
  }
  return true;
}

function gitReader(cwd) {
  const environment = () => {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    );
    return { ...inherited, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  };
  const reader = async args => {
    const result = await execute('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      env: environment()
    });
    return result.stdout;
  };
  reader.blob = async (sha, name) => {
    const result = await execute('git', ['show', `${sha}:${name}`], {
      cwd,
      encoding: 'buffer',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      env: environment()
    });
    return result.stdout;
  };
  return reader;
}

function tagReference(agentRef) {
  if (
    typeof agentRef !== 'string' ||
    !agentRef ||
    /[\s~^:@\\]/u.test(agentRef) ||
    (agentRef.startsWith('refs/') && !agentRef.startsWith('refs/tags/'))
  )
    throw new Error('WEB_ONLY_AGENT_TAG_UNPROVEN');
  return agentRef.startsWith('refs/tags/') ? agentRef : `refs/tags/${agentRef}`;
}

async function protectedSnapshot(git, sha, backendPaths) {
  const root = parsePackage(await git(['show', `${sha}:${ROOT_PACKAGE}`]));
  const files = new Map();
  const entries = (await git(['ls-tree', '-r', '-z', '--full-tree', sha]))
    .split('\0')
    .filter(Boolean);
  for (const line of entries) {
    const separator = line.indexOf('\t');
    const [mode, kind, objectId] = line.slice(0, separator).split(' ');
    const name = line.slice(separator + 1);
    if (name === ROOT_PACKAGE) {
      files.set(name, { mode, kind, content: canonical(normalizedPackage(root)) });
    } else if (name === BETA_PACKAGER) {
      const content = await git.blob(sha, BETA_PACKAGER);
      const addition = Buffer.from(BETA_PROVENANCE_ADDITION);
      const position = content.indexOf(addition);
      const normalized =
        position < 0
          ? content
          : Buffer.concat([
              content.subarray(0, position),
              content.subarray(position + addition.length)
            ]);
      files.set(name, {
        mode,
        kind,
        content: createHash('sha256').update(normalized).digest('hex')
      });
    } else if (pathDecision(name, backendPaths) !== null) files.set(name, { mode, kind, objectId });
  }
  const fingerprint = createHash('sha256')
    .update(canonical(Object.fromEntries(files)))
    .digest('hex');
  return { root, files, fingerprint };
}

/**
 * Compares the actual embedded package revision with the released tag, using
 * complete Git trees rather than a hand-maintained subset of agent folders.
 * This reads historical blobs; it does not require that old package SHA to be
 * checked out, and never substitutes current package files for old provenance.
 * @param {{cwd: string, packageSha: string, agentRef: string, backendPaths?: string[]}} options
 */
export async function comparePackagedAgentInputs({ cwd, packageSha, agentRef, backendPaths = [] }) {
  /** @type {WebOnlyBlocker[]} */
  const blockers = [];
  /** @type {string | null} */
  let agentSha = null;
  /** @type {string | null} */
  let agentInputsDigest = null;
  /** @type {string | null} */
  let packageInputsDigest = null;
  const git = gitReader(cwd);
  try {
    if (!/^[a-f0-9]{40}$/u.test(packageSha ?? ''))
      throw new Error('WEB_ONLY_PACKAGE_SOURCE_UNPROVEN');
    agentSha = (
      await git(['rev-parse', '--verify', '--end-of-options', `${tagReference(agentRef)}^{commit}`])
    ).trim();
    const exactPackage = (
      await git(['rev-parse', '--verify', '--end-of-options', `${packageSha}^{commit}`])
    ).trim();
    if (exactPackage !== packageSha) throw new Error('WEB_ONLY_PACKAGE_SOURCE_UNPROVEN');
    const backend = backendPathSet(backendPaths);
    if (backend.size) {
      const existing = (
        await git(['ls-tree', '-r', '--name-only', '-z', agentSha, '--', ...backend])
      )
        .split('\0')
        .filter(Boolean);
      for (const name of existing)
        blockers.push({ path: name, code: 'DB_EXISTING_MIGRATION_CHANGED' });
    }
    const before = await protectedSnapshot(git, agentSha, backend);
    const after = await protectedSnapshot(git, packageSha, backend);
    agentInputsDigest = before.fingerprint;
    packageInputsDigest = after.fingerprint;
    for (const name of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
      if (canonical(before.files.get(name)) !== canonical(after.files.get(name)))
        blockers.push({ path: name, code: 'WEB_ONLY_AGENT_INPUT_CHANGED' });
    }
    if (!packageCompatible(before.root, after.root))
      blockers.push({ path: ROOT_PACKAGE, code: 'WEB_ONLY_PACKAGE_CHANGED' });
  } catch {
    blockers.push({ path: '.', code: 'WEB_ONLY_PACKAGE_SOURCE_UNPROVEN' });
  }
  return {
    ok: blockers.length === 0,
    blockers,
    agentSha,
    packageSha,
    agentInputsDigest,
    packageInputsDigest
  };
}

/**
 * Pins a clean, checked-out candidate against a local released tag. Remote tag
 * publication, signature verification and live stable.json equality belong to
 * the caller; this function never claims that those network facts were proven.
 * No refs, source paths, or manual compatibility flags enter shell evaluation.
 * @param {{cwd: string, agentRef: string, candidateRef?: string, requireClean?: boolean, backendPaths?: string[]}} options
 */
export async function inspectWebOnlySource({
  cwd,
  agentRef,
  candidateRef = 'HEAD',
  requireClean = true,
  backendPaths = []
}) {
  /** @type {WebOnlyBlocker[]} */
  const blockers = [];
  /** @type {string | null} */
  let sourceSha = null;
  /** @type {string | null} */
  let agentSha = null;
  /** @type {string | null} */
  let agentInputsDigest = null;
  /** @type {string[]} */
  let changedPaths = [];
  const add = (name, code) => {
    if (!blockers.some(item => item.path === name && item.code === code))
      blockers.push({ path: name, code });
  };
  const git = gitReader(cwd);
  const resolve = async ref =>
    (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  const checkWorktree = async () => {
    if (!requireClean) return;
    if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).trim())
      add('.', 'WEB_ONLY_SOURCE_DIRTY');
    // status deliberately ignores these flagged paths. A web build reads the
    // working files anyway, so a nominally clean index is not adequate proof.
    const flags = (await git(['ls-files', '-v', '-z'])).split('\0').filter(Boolean);
    if (flags.some(entry => /^[a-zS]/u.test(entry))) add('.', 'WEB_ONLY_INDEX_UNTRUSTED');
  };
  try {
    if (
      typeof agentRef !== 'string' ||
      !agentRef ||
      /[\s~^:@\\]/u.test(agentRef) ||
      (agentRef.startsWith('refs/') && !agentRef.startsWith('refs/tags/'))
    ) {
      add('.', 'WEB_ONLY_AGENT_TAG_UNPROVEN');
    } else {
      const tag = agentRef.startsWith('refs/tags/') ? agentRef : `refs/tags/${agentRef}`;
      try {
        agentSha = await resolve(tag);
      } catch {
        add('.', 'WEB_ONLY_AGENT_TAG_UNPROVEN');
      }
    }
    try {
      sourceSha = await resolve(candidateRef);
    } catch {
      add('.', 'WEB_ONLY_CANDIDATE_UNPROVEN');
    }
    if (sourceSha && (await resolve('HEAD')) !== sourceSha) add('.', 'WEB_ONLY_CANDIDATE_NOT_HEAD');
    await checkWorktree();
    if (sourceSha && agentSha) {
      try {
        await git(['merge-base', '--is-ancestor', agentSha, sourceSha]);
      } catch {
        add('.', 'WEB_ONLY_ANCESTRY_UNPROVEN');
      }
      // Never hide a protected old path behind a rename into an allowed path.
      changedPaths = (
        await git([
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '-z',
          agentSha,
          sourceSha,
          '--'
        ])
      )
        .split('\0')
        .filter(Boolean)
        .sort();
      blockers.push(...assessWebOnlyChanges(changedPaths, { backendPaths }).blockers);
      const before = parsePackage(await git(['show', `${agentSha}:${ROOT_PACKAGE}`]));
      const after = parsePackage(await git(['show', `${sourceSha}:${ROOT_PACKAGE}`]));
      if (!packageCompatible(before, after)) add(ROOT_PACKAGE, 'WEB_ONLY_PACKAGE_CHANGED');
      const entries = (await git(['ls-tree', '-r', '-z', '--full-tree', sourceSha]))
        .split('\0')
        .filter(Boolean)
        .map(line => {
          const separator = line.indexOf('\t');
          const [mode, kind, objectId] = line.slice(0, separator).split(' ');
          return { mode, kind, objectId, name: line.slice(separator + 1) };
        });
      const changed = new Set(changedPaths);
      for (const entry of entries) {
        if (changed.has(entry.name) && !['100644', '100755'].includes(entry.mode))
          add(entry.name, 'WEB_ONLY_UNSAFE_FILE_MODE');
      }
      const protectedInputs = await comparePackagedAgentInputs({
        cwd,
        packageSha: sourceSha,
        agentRef,
        backendPaths
      });
      for (const blocker of protectedInputs.blockers) add(blocker.path, blocker.code);
      agentInputsDigest = protectedInputs.packageInputsDigest;
      // Catch a checkout mutation while collecting source facts. The caller
      // repeats this boundary after build/verification and immediately prewrite.
      if ((await resolve('HEAD')) !== sourceSha) add('.', 'WEB_ONLY_CANDIDATE_NOT_HEAD');
      await checkWorktree();
    }
  } catch {
    add('.', 'WEB_ONLY_SOURCE_UNREADABLE');
  }
  return {
    ok: blockers.length === 0,
    sourceSha,
    agentSha,
    changedPaths,
    blockers,
    agentInputsDigest
  };
}

export async function newBackendMigrationPaths({ cwd, agentRef }) {
  const git = gitReader(cwd);
  const tag = tagReference(agentRef);
  const status = (
    await git([
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-status',
      '-z',
      tag,
      'HEAD',
      '--',
      'supabase/migrations'
    ])
  )
    .split('\0')
    .filter(Boolean);
  const paths = [];
  for (let index = 0; index < status.length; index += 2) {
    if (status[index] !== 'A') throw new Error('DB_EXISTING_MIGRATION_CHANGED');
    const name = status[index + 1];
    backendPathSet([name]);
    paths.push(name);
  }
  return paths.sort();
}
