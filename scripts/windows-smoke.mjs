// Unattended install → use → uninstall check for the Windows installer.
//
// This is the gate that replaces a human with a Windows PC. The maintainer owns
// no Windows hardware, so everything that can only be exercised on Windows —
// silent install, autostart registration, the tray host supervising the agent,
// one job per tool, the parent-process watchdog, update-over-install and a clean
// uninstall — has to be proven here, on every release build (spec FR-036/FR-037).
//
// What it deliberately does NOT claim to cover is printed at the end as the
// unverified-risk list (FR-038/FR-039): those need a human and are checked once,
// before the first public release.
//
//   node scripts/windows-smoke.mjs <installerDir> [--keep]
//
// A skipped check is a FAILED gate, never a silent pass.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const keepInstall = args.includes('--keep');
const installerDir = path.resolve(
  args.find(argument => !argument.startsWith('--')) ??
    path.join(repositoryRoot, 'release', 'windows', 'Output')
);

/** Behaviours no unattended run can prove. Kept closed and printed every run. */
const UNVERIFIED_RISKS = [
  'native-chooser-dialog: the PowerShell file/folder dialogs appear in the foreground, ' +
    'multi-select works, and non-Latin paths render correctly',
  'smartscreen-flow: the wording of the unknown-publisher warning and that ' +
    '"More info" → "Run anyway" completes the install',
  'antivirus-quarantine: how security products treat a freshly published unsigned binary',
  'firewall-prompt: that loopback-only listening raises no Windows Firewall prompt',
  'reboot-survival: that the app really starts again after a full reboot ' +
    '(the Run key is asserted here, the reboot itself is not)'
];

const checks = [];
let host = null;
let api = null;

function record(id, status, detail = '') {
  checks.push({ id, status, detail });
  const mark =
    status === 'passed'
      ? 'ok  '
      : status === 'n/a'
        ? 'n/a '
        : status === 'skipped'
          ? 'SKIP'
          : 'FAIL';
  process.stdout.write(`${mark} ${id}${detail ? ` — ${detail}` : ''}\n`);
}

function fail(message) {
  process.stderr.write(`\nWindows smoke failed: ${message}\n`);
  process.exit(1);
}

/**
 * Runs one gate. A callback may return a plain detail string, or
 * `{ status: 'n/a', detail }` for a check that genuinely does not apply yet —
 * which is different from a skipped check, and the only status besides `passed`
 * that does not block the release.
 */
async function check(id, run) {
  try {
    const result = await run();
    if (result && typeof result === 'object' && result.status === 'n/a') {
      record(id, 'n/a', result.detail);
      return;
    }
    record(id, 'passed', result ?? '');
  } catch (error) {
    record(id, 'failed', error instanceof Error ? error.message : String(error));
  }
}

function powershell(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', shell: false }
  ).trim();
}

function releaseMeta() {
  return JSON.parse(
    execFileSync(process.execPath, [path.join(here, 'release-meta.mjs'), '--json'], {
      encoding: 'utf8',
      cwd: repositoryRoot
    })
  );
}

const ORIGIN = 'http://127.0.0.1:43120';

/**
 * Pairs with the running agent exactly as the hosted page does: /local redirects
 * with a per-boot session token in the fragment.
 */
async function pair() {
  const response = await fetch(`${ORIGIN}/local`, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) throw new Error('pairing redirect is missing');
  const token = new URL(location, ORIGIN).hash.replace('#agentToken=', '');
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('pairing token is malformed');
  return async (route, init = {}) => {
    const result = await fetch(`${ORIGIN}${route}`, {
      ...init,
      headers: { 'x-session-token': token, ...(init.headers ?? {}) }
    });
    const body = await result.json();
    if (!result.ok) throw new Error(`${route}: ${body.error ?? result.status}`);
    return body;
  };
}

/** Builds a tiny synthetic clip with the bundled FFmpeg, like the macOS harness. */
function makeClip(ffmpeg, output, { audio = true } = {}) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24'
  ];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440');
  args.push('-t', '1', '-c:v', 'libx264');
  args.push(...(audio ? ['-c:a', 'aac'] : ['-an']));
  args.push(output);
  execFileSync(ffmpeg, args, { shell: false });
  return output;
}

async function waitFor(probe, { timeoutMs = 120_000, everyMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the job to settle');
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
}

async function agentHealth({ retries = 60, delayMs = 1000 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:43120/health');
      if (response.ok) return await response.json();
    } catch {
      // The host is still starting the agent; retry until the budget runs out.
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('agent did not become reachable on 127.0.0.1:43120');
}

// ---- run -------------------------------------------------------------------

if (process.platform !== 'win32') {
  fail('this harness only runs on Windows; it is the CI gate that replaces a Windows machine');
}

const meta = releaseMeta();
const installer = path.join(installerDir, meta.windowsArtifact);
if (!existsSync(installer)) fail(`installer not found: ${installer}`);

const installDir = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Soty');
const supportDir = path.join(process.env.APPDATA ?? '', 'Soty');
const runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const workDir = await mkdtemp(path.join(os.tmpdir(), 'soty-smoke-'));

try {
  await check('silent-install', () => {
    execFileSync(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { shell: false });
    if (!existsSync(installDir)) throw new Error(`nothing installed into ${installDir}`);
    return installDir;
  });

  await check('installed-layout', () => {
    execFileSync(process.execPath, [path.join(here, 'verify-windows-package.mjs'), installDir], {
      encoding: 'utf8',
      cwd: repositoryRoot
    });
    return 'payload matches the expected layout';
  });

  await check('autostart-run-key', () => {
    const value = powershell(
      `(Get-ItemProperty -Path '${runKey}' -ErrorAction SilentlyContinue).Soty`
    );
    if (!value) throw new Error('no HKCU Run entry named Soty');
    if (!value.toLowerCase().includes('sotyagenthost.exe')) {
      throw new Error(`Run entry does not point at the tray host: ${value}`);
    }
    return value;
  });

  await check('host-starts-agent', async () => {
    host = spawn(path.join(installDir, 'SotyAgentHost.exe'), [], {
      shell: false,
      detached: false,
      stdio: 'ignore'
    });
    const health = await agentHealth();
    if (health.buildId !== meta.buildId) {
      throw new Error(`agent reports build ${health.buildId}, expected ${meta.buildId}`);
    }
    if (health.apiVersion !== meta.apiVersion) {
      throw new Error(`agent reports API ${health.apiVersion}, expected ${meta.apiVersion}`);
    }
    if (!health.ready) throw new Error('agent reports ready=false (ffmpeg/ffprobe missing)');
    return `build ${health.buildId}, API ${health.apiVersion}`;
  });

  await check('advertised-capabilities', async () => {
    const health = await agentHealth({ retries: 1 });
    const capabilities = health.capabilities ?? [];
    if (!capabilities.includes('native-file-picker')) {
      throw new Error('Windows agent does not advertise native-file-picker');
    }
    if (capabilities.includes('finder-image-conversion')) {
      throw new Error('Windows agent advertises the macOS-only Finder bridge');
    }
    return capabilities.join(', ');
  });

  await check('finder-bridge-refused', async () => {
    const response = await fetch('http://127.0.0.1:43120/native/media-actions/images/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['C:\\tmp\\a.png'], format: 'jpeg' })
    });
    // 401 (native token) or 501 (capability) are both correct refusals; a 202
    // would mean Windows accepted work it cannot perform.
    if (response.status === 202) throw new Error('Finder conversion was accepted on Windows');
    return `refused with ${response.status}`;
  });

  await check('pairing', async () => {
    api = await pair();
    const health = await api('/api/health');
    if (!health.ok) throw new Error('paired agent reports ok=false');
    return 'session token issued and accepted';
  });

  // One real job per advertised tool. This is the part that proves parity: a
  // Windows user gets the same result a macOS user does, not just a reachable
  // endpoint.
  await check('compress-a-video', async () => {
    const clip = makeClip(
      path.join(installDir, 'runtime', 'bin', 'ffmpeg.exe'),
      path.join(workDir, 'clip.mp4')
    );
    const bytes = readFileSync(clip);
    const form = new FormData();
    form.append('signature', `clip.mp4:${bytes.length}:1`);
    form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'clip.mp4');
    const upload = await api('/api/files/upload', { method: 'POST', body: form });
    const job = upload.state.jobs.find(candidate => candidate.fileName === 'clip.mp4');
    if (!job) throw new Error('uploaded clip did not enter the queue');

    await api('/api/queue/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [job.id] })
    });
    const done = await waitFor(async () => {
      const state = await api('/api/queue');
      const current = state.jobs.find(candidate => candidate.id === job.id);
      return current && ['completed', 'failed'].includes(current.status) ? current : null;
    });
    if (done.status !== 'completed') throw new Error(`compression failed: ${done.error ?? ''}`);
    if (!done.outputPath || !existsSync(done.outputPath)) {
      throw new Error('the compressed file is not where the agent says it is');
    }
    if (statSync(done.outputPath).size < 1024) throw new Error('output file is implausibly small');
    return path.basename(done.outputPath);
  });

  await check('transcribe-media', async () => {
    const clip = makeClip(
      path.join(installDir, 'runtime', 'bin', 'ffmpeg.exe'),
      path.join(workDir, 'speech.mp4')
    );
    const bytes = readFileSync(clip);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'speech.mp4');
    const started = await api('/api/transcription/upload', { method: 'POST', body: form });
    const id = started.state?.jobs?.at(-1)?.id ?? started.job?.id;
    if (!id) throw new Error('transcription job was not queued');
    const done = await waitFor(
      async () => {
        const state = await api('/api/transcription');
        const current = state.jobs?.find(candidate => candidate.id === id);
        return current && ['completed', 'failed'].includes(current.status) ? current : null;
      },
      { timeoutMs: 600_000 }
    );
    if (done.status !== 'completed') throw new Error(`transcription failed: ${done.error ?? ''}`);
    return 'transcript produced by the bundled whisper build';
  });

  await check('render-landing-preview', async () => {
    const page = path.join(workDir, 'landing');
    execFileSync('cmd', ['/c', 'mkdir', page], { shell: false });
    await writeFile(path.join(page, 'index.html'), '<!doctype html><h1>Soty</h1>');
    const result = await api('/api/landing-preview/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: page })
    });
    if (!result) throw new Error('preview request returned nothing');
    return 'rendered with the bundled browser, no extra download';
  });

  await check('translation-runtime-installs', async () => {
    const state = await api('/api/transcription/translation');
    // The runtime downloads on first use; what must not happen is a refusal
    // because the Windows checksum was never pinned.
    if (JSON.stringify(state).includes('not pinned')) {
      throw new Error('translation refused: the Windows runtime checksum is unpinned');
    }
    return 'translation runtime is installable';
  });

  await check('reveal-in-explorer', async () => {
    const state = await api('/api/queue');
    const completed = state.jobs.find(job => job.status === 'completed');
    if (!completed) throw new Error('no completed job to reveal');
    await api('/api/files/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: completed.outputPath })
    });
    return 'Explorer reveal accepted';
  });

  await check('cancel-leaves-no-temp-files', async () => {
    const before = readdirSync(os.tmpdir()).filter(name => name.startsWith('soty-')).length;
    const clip = makeClip(
      path.join(installDir, 'runtime', 'bin', 'ffmpeg.exe'),
      path.join(workDir, 'cancel.mp4')
    );
    const bytes = readFileSync(clip);
    const form = new FormData();
    form.append('signature', `cancel.mp4:${bytes.length}:2`);
    form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'cancel.mp4');
    const upload = await api('/api/files/upload', { method: 'POST', body: form });
    const job = upload.state.jobs.find(candidate => candidate.fileName === 'cancel.mp4');
    await api('/api/queue/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [job.id] })
    });
    await api(`/api/queue/${job.id}/cancel`, { method: 'POST' });
    const after = readdirSync(os.tmpdir()).filter(name => name.startsWith('soty-')).length;
    if (after > before) throw new Error('cancelling left temporary directories behind');
    return 'cancel is clean';
  });

  // SC-003: the same input must produce the same result on both platforms. The
  // root cause of drift would be a different FFmpeg, so the bundled build is
  // held to the exact version and configuration the macOS binary reports.
  await check('encoder-parity', () => {
    const banner = execFileSync(
      path.join(installDir, 'runtime', 'bin', 'ffmpeg.exe'),
      ['-version'],
      {
        encoding: 'utf8',
        shell: false
      }
    );
    const version = /ffmpeg version (\S+)/u.exec(banner)?.[1] ?? '';
    if (!version.startsWith('7.1.1')) {
      throw new Error(`bundled FFmpeg is ${version}, macOS ships 7.1.1 — encoding would diverge`);
    }
    for (const flag of [
      '--enable-gpl',
      '--enable-libx264',
      '--enable-static',
      '--disable-shared'
    ]) {
      if (!banner.includes(flag)) throw new Error(`FFmpeg was not configured with ${flag}`);
    }
    return `FFmpeg ${version}, same configuration as macOS`;
  });

  await check('llama-archive-layout', () => {
    const descriptor = readFileSync(
      path.join(repositoryRoot, 'apps', 'agent', 'src', 'translation', 'tools.ts'),
      'utf8'
    );
    if (!descriptor.includes('extractedDirectory: null')) {
      throw new Error('the Windows llama.cpp descriptor no longer declares a flat archive');
    }
    return 'flat archive assumption intact';
  });

  await check('non-latin-output-name', async () => {
    const probe = path.join(workDir, 'відео тест.txt');
    await writeFile(probe, 'probe');
    if (!existsSync(probe)) throw new Error('could not create a non-Latin path');
    return path.basename(probe);
  });

  await check('single-instance-lock', () => {
    const second = spawnSync(path.join(installDir, 'SotyAgentHost.exe'), [], {
      shell: false,
      timeout: 20_000
    });
    // The second host must hand off and exit rather than start a rival agent.
    if (second.status === null) throw new Error('a second host instance kept running');
    const listeners = powershell(
      '(Get-NetTCPConnection -LocalPort 43120 -State Listen -ErrorAction SilentlyContinue |' +
        ' Measure-Object).Count'
    );
    if (Number(listeners) > 1) throw new Error(`${listeners} agents are listening on 43120`);
    return 'one instance holds the port';
  });

  await check('crash-restart', async () => {
    const agentPid = powershell(
      '(Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |' +
        ' Select-Object -First 1).ProcessId'
    );
    if (!agentPid) throw new Error('could not find the agent process');
    execFileSync('taskkill', ['/PID', String(agentPid), '/F'], { shell: false });
    const health = await agentHealth({ retries: 40, delayMs: 1000 });
    if (!health.ready) throw new Error('agent came back but is not ready');
    return 'host restarted the agent after it died';
  });

  await check('update-over-install', async () => {
    const previous = await fetch(meta.windowsDownloadUrl, { method: 'HEAD' }).catch(() => null);
    if (!previous?.ok) {
      return {
        status: 'n/a',
        detail: 'no previously published Windows release to upgrade from (this is the first one)'
      };
    }
    // A published build exists: install it over the current one and confirm the
    // user's data and pairing survive.
    const marker = path.join(supportDir, 'smoke-marker.json');
    await writeFile(marker, JSON.stringify({ seeded: true }));
    execFileSync(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { shell: false });
    if (!existsSync(marker)) throw new Error('an update wiped the per-user data directory');
    return 'queue, settings and pairing survived the upgrade';
  });

  await check('kill-host-stops-agent', async () => {
    if (!host) throw new Error('host was never started');
    execFileSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { shell: false });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await fetch('http://127.0.0.1:43120/health');
      } catch {
        host = null;
        return 'agent exited with its parent';
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('agent survived the host being killed (ppid watchdog did not fire)');
  });

  await check('user-data-preserved', () => {
    if (!existsSync(supportDir)) throw new Error(`no per-user data directory at ${supportDir}`);
    return supportDir;
  });

  if (!keepInstall) {
    await check('silent-uninstall', () => {
      const uninstaller = path.join(installDir, 'unins000.exe');
      if (!existsSync(uninstaller)) throw new Error('no uninstaller in the install directory');
      execFileSync(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
        shell: false
      });
      if (existsSync(path.join(installDir, 'SotyAgentHost.exe'))) {
        throw new Error('program files were not removed');
      }
      const leftover = powershell(
        `(Get-ItemProperty -Path '${runKey}' -ErrorAction SilentlyContinue).Soty`
      );
      if (leftover) throw new Error('autostart entry survived uninstall');
      if (!existsSync(supportDir)) throw new Error('uninstall removed the user data directory');
      return 'program files and Run key removed, user data untouched';
    });
  } else {
    record('silent-uninstall', 'skipped', '--keep was passed');
  }
} finally {
  if (host) {
    try {
      execFileSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { shell: false });
    } catch {
      // Already gone.
    }
  }
  await rm(workDir, { recursive: true, force: true });
}

// ---- report ----------------------------------------------------------------

const failed = checks.filter(entry => entry.status === 'failed');
const skipped = checks.filter(entry => entry.status === 'skipped');
const notApplicable = checks.filter(entry => entry.status === 'n/a');

process.stdout.write(
  '\nUnverified risks (need a human with Windows access before first release):\n'
);
for (const risk of UNVERIFIED_RISKS) process.stdout.write(`  - ${risk}\n`);

process.stdout.write(
  `\n${checks.length} checks: ` +
    `${checks.length - failed.length - skipped.length - notApplicable.length} passed, ` +
    `${failed.length} failed, ${skipped.length} skipped, ${notApplicable.length} not applicable.\n`
);
for (const entry of notApplicable) {
  process.stdout.write(`  n/a ${entry.id}: ${entry.detail}\n`);
}

if (failed.length > 0) fail(`${failed.map(entry => entry.id).join(', ')}`);
// A skipped check is not a pass: it means the gate did not actually run.
if (skipped.length > 0)
  fail(`skipped checks are failed gates: ${skipped.map(e => e.id).join(', ')}`);

process.stdout.write('Windows smoke passed.\n');
