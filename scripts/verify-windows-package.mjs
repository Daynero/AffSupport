// Checks the staged Windows payload and the compiled installer before either is
// allowed near a user.
//
// The point is to fail in CI rather than on someone's PC: an incomplete or
// internally inconsistent payload must never become a downloadable installer
// (spec FR-030). Runs on any OS — the layout and PE checks are pure file
// inspection — so a staged tree can also be checked from macOS.
//
//   node scripts/verify-windows-package.mjs [stageDir] [outputDir]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  peMachine,
  PE_MACHINE_AMD64,
  RELEASE_IDENTITY_FIELDS,
  REQUIRED_STAGE_ENTRIES,
  WHISPER_COMPANION_DLLS
} from './lib/windows-package-layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const stageDir = path.resolve(args[0] ?? path.join(repositoryRoot, 'release', 'windows', 'stage'));
const outputDir = args[1] ? path.resolve(args[1]) : null;

const problems = [];

function fail(message) {
  process.stderr.write(`Windows package check failed: ${message}\n`);
  process.exit(1);
}

if (!existsSync(stageDir)) fail(`stage directory not found: ${stageDir}`);

// ---- Layout the tray host and the agent both depend on --------------------

for (const entry of REQUIRED_STAGE_ENTRIES) {
  const target = path.join(stageDir, ...entry.path.split('/'));
  if (!existsSync(target)) {
    problems.push(`missing ${entry.path}`);
    continue;
  }
  const stats = statSync(target);
  if (stats.isFile() && entry.minBytes && stats.size < entry.minBytes) {
    problems.push(`${entry.path} is only ${stats.size} bytes`);
    continue;
  }
  if (entry.x64Executable) {
    const machine = peMachine(readFileSync(target));
    if (!machine.ok) {
      problems.push(`${entry.path}: ${machine.error}`);
    } else if (machine.value !== PE_MACHINE_AMD64) {
      problems.push(`${entry.path} is not x64 (machine 0x${machine.value.toString(16)})`);
    }
  }
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
  `Windows package verified: ${stageDir}${outputDir ? ` and installer in ${outputDir}` : ''}\n`
);
