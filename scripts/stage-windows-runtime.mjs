// Stages everything the Windows installer bundles, mirroring the macOS
// "Contents/Resources" layout the agent's relative paths expect:
//
//   release/windows/stage/
//     runtime/node.exe                        NODE_BINARY_WIN
//     runtime/bin/ffmpeg.exe                  FFMPEG_BINARY_WIN
//     runtime/bin/ffprobe.exe                 FFPROBE_BINARY_WIN
//     runtime/bin/whisper-cli.exe             WHISPER_BINARY_WIN
//     runtime/models/ggml-silero-v5.1.2.bin   WHISPER_VAD_MODEL
//     runtime/models/ggml-large-v3.bin        WHISPER_MODEL (optional)
//     agent/{dist,package.json,node_modules}  stageAgentRuntime (lockfile-exact)
//     web/dist                                built hosted UI fallback
//     licenses/, THIRD_PARTY_NOTICES.md       attribution + GPL source offers
//     release.json                            release identity (release-meta.mjs --json)
//
// Meant to run ON a Windows machine after `npm ci && npm run build`
// (docs/WINDOWS.md has the full installer pipeline). `--dry-run` works
// anywhere: it validates what it can and prints the copy plan without
// touching the filesystem.
//
//   node scripts/stage-windows-runtime.mjs [--dry-run] [destination]
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot, stageAgentRuntime } from './lib/agent-staging.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter(argument => argument !== '--dry-run');
const destination = path.resolve(positional[0] ?? path.join('release', 'windows', 'stage'));

/** Dry-run placeholders so the plan can be printed with no environment at all. */
const DRY_RUN_DEFAULTS = {
  NODE_BINARY_WIN: 'C:\\wishly-deps\\node.exe',
  FFMPEG_BINARY_WIN: 'C:\\wishly-deps\\ffmpeg.exe',
  FFPROBE_BINARY_WIN: 'C:\\wishly-deps\\ffprobe.exe',
  WHISPER_BINARY_WIN: 'C:\\wishly-deps\\whisper-cli.exe',
  WHISPER_LIBS_WIN: 'C:\\wishly-deps\\whisper-libs',
  WHISPER_VAD_MODEL: 'C:\\wishly-deps\\ggml-silero-v5.1.2.bin'
};

const inputs = [
  { env: 'NODE_BINARY_WIN', target: 'runtime/node.exe', mustBeExe: true },
  { env: 'FFMPEG_BINARY_WIN', target: 'runtime/bin/ffmpeg.exe', mustBeExe: true },
  { env: 'FFPROBE_BINARY_WIN', target: 'runtime/bin/ffprobe.exe', mustBeExe: true },
  { env: 'WHISPER_BINARY_WIN', target: 'runtime/bin/whisper-cli.exe', mustBeExe: true },
  // The official whisper.cpp Windows build links against whisper.dll/ggml*.dll
  // rather than being statically linked like the macOS binary, so the shared
  // libraries next to whisper-cli.exe must be staged beside it. Optional so a
  // future fully static build can simply omit it.
  {
    env: 'WHISPER_LIBS_WIN',
    target: 'runtime/bin',
    mustBeExe: false,
    optional: true,
    directory: true
  },
  { env: 'WHISPER_VAD_MODEL', target: 'runtime/models/ggml-silero-v5.1.2.bin', mustBeExe: false },
  // Optional exactly like the mac pipeline: omit to ship a small installer and
  // let the agent download ggml-large-v3 on first use.
  {
    env: 'WHISPER_MODEL',
    target: 'runtime/models/ggml-large-v3.bin',
    mustBeExe: false,
    optional: true
  },
  // GPL compliance: the mac DMG bundles the FFmpeg/x264 source archives it was
  // built from. Provide the Windows build's matching archives the same way.
  {
    env: 'FFMPEG_SOURCE_ARCHIVE_WIN',
    target: 'licenses/sources/(ffmpeg source archive)',
    mustBeExe: false,
    optional: true,
    intoSources: true
  },
  {
    env: 'X264_SOURCE_ARCHIVE_WIN',
    target: 'licenses/sources/(x264 source archive)',
    mustBeExe: false,
    optional: true,
    intoSources: true
  }
];

/**
 * Reports and exits.
 *
 * Annotated `never` so the checker knows control does not continue past a call
 * — without it, every value guarded by a `fail()` reads as possibly undefined
 * further down, which is the shape most of this file's type errors took.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const plan = [];
const warnings = [];

for (const input of inputs) {
  let source = process.env[input.env]?.trim();
  if (!source && dryRun) source = DRY_RUN_DEFAULTS[input.env];
  if (!source) {
    if (input.optional) {
      warnings.push(`${input.env} not set — ${path.posix.basename(input.target)} not bundled.`);
      continue;
    }
    fail(`Set ${input.env} (path staged as ${input.target}).`);
  }
  if (input.mustBeExe && !source.toLowerCase().endsWith('.exe')) {
    fail(`${input.env} must point at a Windows .exe, got: ${source}`);
  }
  if (!dryRun && !existsSync(source)) {
    fail(`${input.env} does not exist: ${source}`);
  }
  if (input.directory && !dryRun && !statSync(source).isDirectory()) {
    fail(`${input.env} must point at a directory, got: ${source}`);
  }
  const target = input.intoSources
    ? path.posix.join('licenses/sources', path.basename(source))
    : input.target;
  plan.push({ source, target });
}

// Static repository inputs staged verbatim (same set package-mac.sh copies).
const repositoryInputs = [
  { source: 'apps/agent/dist', target: 'agent/dist', via: 'stageAgentRuntime' },
  { source: 'apps/web/dist', target: 'web/dist' },
  { source: 'THIRD_PARTY_NOTICES.md', target: 'THIRD_PARTY_NOTICES.md' },
  { source: 'packaging/licenses/llama.cpp-LICENSE', target: 'licenses/llama.cpp-LICENSE' },
  { source: 'packaging/licenses/GEMMA_TERMS.md', target: 'licenses/GEMMA_TERMS.md' },
  {
    source: 'packaging/licenses/GEMMA_PROHIBITED_USE_POLICY.md',
    target: 'licenses/GEMMA_PROHIBITED_USE_POLICY.md'
  },
  { source: 'packaging/licenses/NOTICE-Gemma.txt', target: 'licenses/NOTICE-Gemma.txt' },
  {
    source: 'packaging/licenses/multilingual-e5-small-MIT.txt',
    target: 'licenses/multilingual-e5-small-MIT.txt'
  }
];

if (dryRun) {
  process.stdout.write(`Dry run — staging plan for ${destination}\n\n`);
  for (const { source, target } of plan) {
    process.stdout.write(`  ${target.padEnd(42)} <- ${source}\n`);
  }
  for (const { source, target, via } of repositoryInputs) {
    process.stdout.write(
      `  ${target.padEnd(42)} <- <repo>/${source}${via ? ` (via ${via}, lockfile-exact node_modules)` : ''}\n`
    );
  }
  process.stdout.write(
    `  ${'release.json'.padEnd(42)} <- node scripts/release-meta.mjs --json $(git rev-parse HEAD)\n`
  );
  for (const warning of warnings) process.stdout.write(`  note: ${warning}\n`);
  process.stdout.write('\nNo files were copied. Re-run without --dry-run on a Windows machine.\n');
  process.exit(0);
}

// ---- Real staging (Windows machine) ------------------------------------

for (const { source } of repositoryInputs) {
  if (!existsSync(path.join(repositoryRoot, source))) {
    fail(`Missing ${source} — run \`npm ci && npm run build\` first.`);
  }
}

await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length > 0) {
  fail(`Windows stage destination must be empty: ${destination}`);
}

for (const directory of ['runtime/bin', 'runtime/models', 'web', 'licenses/sources']) {
  await mkdir(path.join(destination, ...directory.split('/')), { recursive: true });
}

for (const { source, target } of plan) {
  await cp(source, path.join(destination, ...target.split('/')), { recursive: true });
}

const manifest = await stageAgentRuntime(path.join(destination, 'agent'));
process.stdout.write(
  `Staged ${manifest.dependencyCount} production dependency packages for the Agent.\n`
);

for (const { source, target, via } of repositoryInputs) {
  if (via) continue; // agent/dist already staged by stageAgentRuntime above.
  await cp(path.join(repositoryRoot, source), path.join(destination, ...target.split('/')), {
    recursive: true
  });
}

const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8'
}).trim();
const releaseJson = execFileSync(
  process.execPath,
  [path.join(repositoryRoot, 'scripts/release-meta.mjs'), '--json', sourceRevision],
  { cwd: repositoryRoot, encoding: 'utf8' }
);
await writeFile(path.join(destination, 'release.json'), releaseJson, 'utf8');

for (const warning of warnings) process.stdout.write(`note: ${warning}\n`);
process.stdout.write(`Windows runtime staged at ${destination}\n`);
