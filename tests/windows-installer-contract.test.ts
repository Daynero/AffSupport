import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_ARTIFACT_NAME_WINDOWS } from '../packages/shared/src/release.js';

/**
 * The Inno Setup script cannot be executed from macOS, so its load-bearing
 * rules are asserted at the source level. These are the properties a Windows
 * user actually feels: upgrades that keep their data, an update that never
 * interrupts a running job, and an uninstall that leaves their media alone.
 */
const installer = readFileSync('packaging/windows-installer.iss', 'utf8');
const workflow = readFileSync('.github/workflows/release-windows.yml', 'utf8');
const smoke = readFileSync('scripts/windows-smoke.mjs', 'utf8');
const launcher = readFileSync('packaging/Launcher.swift', 'utf8');
const agentProcess = readFileSync('packaging/windows/SotyAgentHost/AgentProcess.cs', 'utf8');
const trayApplication = readFileSync('packaging/windows/SotyAgentHost/TrayApplication.cs', 'utf8');

describe('the tray host is a launcher, on the same contract as the macOS one', () => {
  /**
   * Both hosts spawn the same agent binary, so they owe it the same environment.
   * A variable one passes and the other forgets is invisible until a user hits
   * the path that needs it — and on Windows that path is an orphaned agent
   * holding the port forever.
   */
  const REQUIRED_BY_THE_AGENT = [
    'PACKAGED_APP',
    'AGENT_PORT',
    'AGENT_SUPPORT_DIRECTORY_NAME',
    'AGENT_NATIVE_TOKEN',
    'AGENT_LAUNCHER_PID',
    'AGENT_ENTITLEMENT_PUBLIC_KEY'
  ];

  it.each(REQUIRED_BY_THE_AGENT)('passes %s, as the macOS launcher does', variable => {
    expect(launcher, `Launcher.swift should pass ${variable}`).toContain(`"${variable}"`);
    expect(agentProcess, `AgentProcess.cs should pass ${variable}`).toContain(
      `Environment["${variable}"]`
    );
  });

  it('gives the agent a watchdog that can actually fire on Windows', () => {
    // The agent decides it has been orphaned in one of two ways: its parent PID
    // changed, or the launcher PID it was handed is gone. Windows never
    // reparents an orphan — the recorded parent PID keeps pointing at a dead
    // process — so the second test is the only one that can ever be true here.
    expect(agentProcess).toContain('Environment["AGENT_LAUNCHER_PID"]');
    expect(agentProcess).toContain('Environment.ProcessId');
  });

  it('handles the agent exit codes the macOS launcher uses', () => {
    // The agent uses 75 to request a restart and 76 to signal a drained update
    // handoff. Windows can also report native termination statuses, so every
    // non-handoff exit gets the same bounded restart budget as 75.
    for (const code of ['75', '76']) {
      expect(launcher, `Launcher.swift should handle exit ${code}`).toContain(code);
      expect(trayApplication, `TrayApplication.cs should handle exit ${code}`).toContain(code);
    }
    expect(trayApplication).toContain('UpdateHandoffExitCode');
    expect(trayApplication).toContain('runtimeRestartAttempts < MaxRuntimeRestarts');
  });

  it('waits for a port another copy took over, rather than calling it a crash', () => {
    // macOS checks whether something still answers on the port before declaring
    // the exit a failure. The bounded wait already exists on this side; it just
    // was not reached.
    const exited = trayApplication.slice(
      trayApplication.indexOf('private async void OnAgentExited')
    );
    const probe = exited.indexOf('ProbeAsync');
    const failure = exited.indexOf('ShowFailure');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(failure);
  });

  it('takes a sibling host down with its agent during a handoff', () => {
    // Killing only the host leaves its agent holding the port that the instance
    // doing the killing is about to wait for — turning an update into the
    // "an old Agent process is still using port" dead end.
    const terminate = trayApplication.slice(trayApplication.indexOf('TerminateOtherHostInstances'));
    expect(terminate).toMatch(/Kill\(entireProcessTree: true\)/u);
  });
});

describe('the smoke harness talks to routes that exist', () => {
  /**
   * The release gate calls the agent over HTTP, and nothing type-checks those
   * strings. One of them named a route that was never registered: `api()`
   * throws on the 404, so the gate could not pass — and no Windows installer
   * has ever been produced, because the pipeline stopped there every time.
   *
   * Reading the two sides and comparing them is cheap and would have caught it
   * on the commit that introduced it.
   */
  const AGENT_SRC = 'apps/agent/src';

  function registeredRoutes(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(AGENT_SRC);
    const routes: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /app\.(?:get|post|put|delete|patch)[^(]*\(\s*'([^']+)'/gu
      )) {
        routes.push(match[1]);
      }
    }
    return routes;
  }

  // Both `/a/:id/b` and an interpolated `/a/${x}/b` collapse to the same shape,
  // so a route with a parameter matches its registration.
  function shape(route: string): string {
    return route
      .replace(/\$\{[^}]*\}/gu, '*')
      .split('/')
      .map(segment => (segment.startsWith(':') || segment === '*' ? '*' : segment))
      .join('/');
  }

  it('calls only routes the agent registers', () => {
    const registered = new Set(registeredRoutes().map(shape));
    const called = new Set(
      [...smoke.matchAll(/['`](\/(?:api|native)\/[^'`\s]*)['`]/gu)].map(match => shape(match[1]))
    );
    expect(called.size, 'no agent routes found in the harness').toBeGreaterThan(5);
    // Reported together, not one at a time: the first run of this check found
    // five wrong routes, and failing on the first would have hidden four.
    const missing = [...called].filter(route => !registered.has(route));
    expect(missing, 'called by the smoke harness but never registered').toEqual([]);
  });
});

describe('installer upgrade path', () => {
  it('keeps a stable AppId, without which upgrades install side by side', () => {
    const appId = /AppId=\{\{([0-9A-F-]+)/iu.exec(installer)?.[1];
    expect(appId).toBe('9E1FA1D4-6C3B-4A34-9D06-2B62E7C6A3F1');
  });

  it('closes the running application before replacing files', () => {
    expect(installer).toMatch(/CloseApplications=yes/u);
    expect(installer).toMatch(/function PrepareToInstall/u);
  });

  it('refuses to upgrade over a job in flight instead of killing it', () => {
    // FR-033: an update must not replace files while work is running.
    expect(installer).toMatch(/function AgentIsBusy/u);
    expect(installer).toMatch(/"busy":true/u);
    const prepare = installer.slice(installer.indexOf('function PrepareToInstall'));
    const busyGuard = prepare.indexOf('AgentIsBusy()');
    const kill = prepare.indexOf('taskkill');
    expect(busyGuard).toBeGreaterThan(-1);
    // The guard must come first, or the job is already dead by the time we ask.
    expect(busyGuard).toBeLessThan(kill);
  });

  it('registers autostart per-user and removes it on uninstall', () => {
    expect(installer).toContain('Root: HKCU; Subkey: "Software');
    expect(installer).toContain('CurrentVersion\\Run"');
    expect(installer).toMatch(/Flags: uninsdeletevalue/u);
  });

  it('stops the host on uninstall', () => {
    expect(installer).toMatch(/\[UninstallRun\]/u);
    expect(installer).toMatch(/taskkill \/IM SotyAgentHost\.exe/u);
  });

  it('never touches the per-user data directory', () => {
    // Only {app} is installed to and removed; %APPDATA%\\Soty is the user's.
    expect(installer).not.toMatch(/userappdata/iu);
  });

  it('names the artifact the release contract expects', () => {
    const base = RELEASE_ARTIFACT_NAME_WINDOWS.replace(/\.exe$/u, '').replace(
      /v\d+\.\d+\.\d+/u,
      'v__PRODUCT_VERSION__'
    );
    expect(installer).toContain(`OutputBaseFilename=${base}`);
  });

  it('ships unsigned, with no signing step anywhere in the pipeline', () => {
    // A deliberate decision, mirroring the macOS ad-hoc signature.
    expect(workflow).not.toMatch(/signtool/u);
    expect(installer).not.toMatch(/^SignTool=/mu);
  });
});

describe('every rendered placeholder is supplied', () => {
  it('renders each __TOKEN__ the installer declares', () => {
    const tokens = new Set(installer.match(/__[A-Z0-9_]+__/gu) ?? []);
    expect(tokens.size).toBeGreaterThan(0);
    for (const token of tokens) {
      const name = token.replaceAll('_', '');
      // The workflow passes tokens as "NAME=value" to render-launcher.mjs.
      const key = token.slice(2, -2);
      expect(workflow, `${token} is never rendered`).toMatch(new RegExp(`"${key}=`, 'u'));
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('smoke harness covers the gates the release depends on', () => {
  const required = [
    'silent-install',
    'installed-layout',
    'autostart-run-key',
    'host-starts-agent',
    'advertised-capabilities',
    'compress-a-video',
    'transcribe-media',
    'render-landing-preview',
    'encoder-parity',
    'single-instance-lock',
    'crash-restart',
    'update-over-install',
    'kill-host-stops-agent',
    'silent-uninstall'
  ];

  it('runs every required check', () => {
    for (const id of required) {
      expect(smoke, `${id} is not covered`).toContain(`'${id}'`);
    }
  });

  it('orphans the agent instead of killing it, so the watchdog is what is tested', () => {
    // `taskkill /T` takes the whole tree, so the agent dies because taskkill
    // killed it — the gate passed no matter what the watchdog did, and for a
    // while the watchdog did nothing at all on Windows.
    const gate = smoke.slice(smoke.indexOf("check('kill-host-stops-agent'"));
    const kill = gate.slice(0, gate.indexOf('for (let attempt'));
    expect(kill).toContain('taskkill');
    expect(kill, 'the host must be killed alone, without /T').not.toContain("'/T'");
  });

  it('restarts the agent after any unexpected Windows process exit', () => {
    const exitHandler = trayApplication.slice(
      trayApplication.indexOf('private async void OnAgentExited'),
      trayApplication.indexOf('private async Task<InstalledRelease?>')
    );
    expect(exitHandler).toContain('exitCode == UpdateHandoffExitCode');
    expect(exitHandler).toContain('runtimeRestartAttempts < MaxRuntimeRestarts');
    expect(exitHandler).not.toContain('exitCode == RestartableExitCode');
  });

  it('treats a skipped check as a failed gate', () => {
    expect(smoke).toMatch(/skipped checks are failed gates/u);
  });

  it('prints the closed unverified-risk list on every run', () => {
    expect(smoke).toMatch(/UNVERIFIED_RISKS/u);
    for (const risk of ['smartscreen-flow', 'antivirus-quarantine', 'firewall-prompt']) {
      expect(smoke).toContain(risk);
    }
  });
});
