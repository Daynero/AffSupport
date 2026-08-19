import { readFileSync } from 'node:fs';
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
