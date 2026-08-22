// Checks the staged Windows payload and the compiled installer before either is
// allowed near a user.
//
// The point is to fail in CI rather than on someone's PC: an incomplete or
// internally inconsistent payload must never become a downloadable installer
// (spec FR-030). Runs on any OS — the layout and PE checks are pure file
// inspection — so a staged tree can also be checked from macOS.
//
//   node scripts/verify-windows-package.mjs [stageDir] [outputDir] [--host <dir>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  peMachine,
  PE_MACHINE_AMD64,
  RELEASE_IDENTITY_FIELDS,
  REQUIRED_HOST_ENTRIES,
  REQUIRED_STAGE_ENTRIES,
  WHISPER_COMPANION_DLLS
} from './lib/windows-package-layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const hostFlag = args.indexOf('--host');
const hostDir = hostFlag === -1 ? null : path.resolve(args[hostFlag + 1] ?? '');
const positional = args.filter(
  (argument, index) => !argument.startsWith('--') && index !== hostFlag + 1 && index !== hostFlag
);
const stageDir = path.resolve(
  positional[0] ?? path.join(repositoryRoot, 'release', 'windows', 'stage')
);
const outputDir = positional[1] ? path.resolve(positional[1]) : null;

const problems = [];

function fail(message) {
  process.stderr.write(`Windows package check failed: ${message}\n`);
  process.exit(1);
}

if (!existsSync(stageDir)) fail(`stage directory not found: ${stageDir}`);

// ---- Layout the tray host and the agent both depend on --------------------

function checkEntries(root, entries, label) {
  for (const entry of entries) {
    const target = path.join(root, ...entry.path.split('/'));
    if (!existsSync(target)) {
      problems.push(`missing ${label}${entry.path}`);
      continue;
    }
    const stats = statSync(target);
    if (stats.isFile() && entry.minBytes && stats.size < entry.minBytes) {
      problems.push(`${label}${entry.path} is only ${stats.size} bytes`);
      continue;
    }
    if (entry.x64Executable) {
      const machine = peMachine(readFileSync(target));
      if (!machine.ok) {
        problems.push(`${label}${entry.path}: ${machine.error}`);
      } else if (machine.value !== PE_MACHINE_AMD64) {
        problems.push(`${label}${entry.path} is not x64 (machine 0x${machine.value.toString(16)})`);
      }
    }
  }
}

checkEntries(stageDir, REQUIRED_STAGE_ENTRIES, '');

// A Vite build with missing public environment values is syntactically valid,
// so layout checks alone cannot distinguish it from a usable UI. Confirm that
// the production Supabase endpoint and public browser key made it into the
// staged bundle before an installer can be published.
const productionWebEnvironment = Object.fromEntries(
  readFileSync(path.join(repositoryRoot, 'apps', 'web', '.env.production'), 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    })
);
const stagedWebRoot = path.join(stageDir, 'web', 'dist');
if (existsSync(stagedWebRoot)) {
  const bundle = [];
  const collectBundleText = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collectBundleText(target);
      else if (/\.(?:html|js)$/u.test(entry.name)) bundle.push(readFileSync(target, 'utf8'));
    }
  };
  collectBundleText(stagedWebRoot);
  const bundledText = bundle.join('\n');
  for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']) {
    const expected = productionWebEnvironment[name];
    if (!expected || !bundledText.includes(expected)) {
      problems.push(`web/dist does not contain the production ${name}`);
    }
  }
}

// The tray host lives beside the stage rather than inside it, and the installer
// copies its directory with a wildcard — so a missing or 32-bit host compiles
// into a perfectly valid installer that installs nothing that runs.
if (hostDir) {
  if (!existsSync(hostDir)) problems.push(`tray host directory not found: ${hostDir}`);
  else checkEntries(hostDir, REQUIRED_HOST_ENTRIES, 'host/');
}

// The official whisper.cpp Windows build is DLL-linked (unlike the statically
// linked macOS binary), so shipping the .exe alone produces a package that
// fails on first use with a missing-DLL dialog.
const whisperCli = path.join(stageDir, 'runtime', 'bin', 'whisper-cli.exe');
if (existsSync(whisperCli)) {
  const imports = readFileSync(whisperCli).toString('latin1');
  for (const dll of WHISPER_COMPANION_DLLS) {
    if (imports.includes(dll) && !existsSync(path.join(stageDir, 'runtime', 'bin', dll))) {
      problems.push(`whisper-cli.exe imports ${dll} but it was not staged next to it`);
    }
  }
}

// ---- Release identity must match the contract, not a hand-typed value -----

const releaseJsonPath = path.join(stageDir, 'release.json');
if (existsSync(releaseJsonPath)) {
  const staged = JSON.parse(readFileSync(releaseJsonPath, 'utf8'));
  const expected = JSON.parse(
    execFileSync(process.execPath, [path.join(here, 'release-meta.mjs'), '--json'], {
      encoding: 'utf8',
      cwd: repositoryRoot
    })
  );
  for (const key of RELEASE_IDENTITY_FIELDS) {
    if (staged[key] !== expected[key]) {
      problems.push(
        `release.json ${key} is ${JSON.stringify(staged[key])}, ` +
          `expected ${JSON.stringify(expected[key])}`
      );
    }
  }

  // ---- The compiled installer, when one was produced ----------------------
  if (outputDir) {
    if (!existsSync(outputDir)) {
      problems.push(`installer output directory not found: ${outputDir}`);
    } else {
      const installer = path.join(outputDir, expected.windowsArtifact);
      if (!existsSync(installer)) {
        problems.push(
          `expected installer ${expected.windowsArtifact} in ${outputDir} ` +
            `(the name must equal RELEASE_ARTIFACT_NAME_WINDOWS)`
        );
      } else if (statSync(installer).size < 20 * 1024 * 1024) {
        problems.push(
          `${expected.windowsArtifact} is only ${statSync(installer).size} bytes — ` +
            `too small to contain the bundled runtime`
        );
      }
    }
  }
}

if (problems.length > 0) fail(`\n  ${problems.join('\n  ')}`);

process.stdout.write(
  `Windows package verified: ${stageDir}` +
    `${hostDir ? `, tray host in ${hostDir}` : ''}` +
    `${outputDir ? ` and installer in ${outputDir}` : ''}\n`
);
