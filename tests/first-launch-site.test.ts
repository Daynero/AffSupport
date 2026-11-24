import { removeTemporaryDirectory } from './support/temp-dir.js';
import { describeRequiring, requirePlatform } from './support/requires.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The first start of Soty opens its website, once per user per computer, and no later start
 * does (070, owner 2026-11-24). The decision lives in both native hosts — the macOS launcher
 * and the Windows tray host — because each is the thing a person starts, and each owns the
 * suppressions a verification run sets.
 */

const between = (source: string, start: string, end: string) =>
  source.slice(source.indexOf(start), source.indexOf(end) + end.length);

describe('first launch opens the site (wiring)', () => {
  it('asks once, before the Agent starts, and opens only when the Agent answers', async () => {
    const launcher = await readFile('packaging/Launcher.swift', 'utf8');
    const finishLaunching = between(
      launcher,
      'func applicationDidFinishLaunching',
      'func applicationShouldTerminateAfterLastWindowClosed'
    );
    // Only the instance that owns the lock and starts the Agent decides; asking before the
    // Agent starts is what keeps its first state file from answering "ran before".
    expect(finishLaunching.indexOf('openSiteWhenReady = decideFirstLaunch()')).toBeGreaterThan(
      finishLaunching.indexOf('if acquireInstanceLock()')
    );
    expect(finishLaunching.indexOf('openSiteWhenReady = decideFirstLaunch()')).toBeLessThan(
      finishLaunching.indexOf('startAgentWhenPortIsFree()')
    );
    const readiness = between(
      launcher,
      '  private func checkReadiness() {',
      '  private func beginInstalledBuildMonitoring()'
    );
    expect(readiness).toContain('self.openSiteOnFirstLaunch()');
    const decide = between(
      launcher,
      'private func decideFirstLaunch()',
      'private func openSiteOnFirstLaunch()'
    );
    expect(decide).toContain('effectiveSupportDirectoryName != supportDirectoryName');
    expect(decide).toContain('environment["NO_OPEN"] == "1"');
    expect(decide).toContain('environment["AGENT_UPDATE_HANDOFF"] == "1"');
    // The site the build is configured for — prod or beta — never a written-in address; next
    // only through this Mac's own opt-in to next updates (070 T069).
    expect(launcher).toContain('built: "__PUBLIC_SITE_ORIGIN__"');
    expect(launcher).toContain('UserDefaults.standard.object(forKey: "SotyUpdateChannel")');
    // The Finder offer does not land on top of the site the first start opened: it waits for
    // the next start, unmarked (070 T069).
    expect(finishLaunching).toContain('finderOfferDeferred = openSiteWhenReady');
    const offer = between(
      launcher,
      'private func scheduleFinderIntegrationOffer()',
      'UserDefaults.standard.set(true, forKey: finderIntegrationOfferKey)'
    );
    expect(offer).toContain('!finderOfferDeferred,');
    // A second start while Soty runs is not a first launch either.
    const existingInstance = between(
      launcher,
      'private func handleExistingInstance',
      'private func waitForPreviousAgent'
    );
    expect(existingInstance).not.toContain('openSiteOnFirstLaunch');
  });

  it('the Windows host makes the same decision at the same moments', async () => {
    const [tray, firstLaunch] = await Promise.all([
      readFile('packaging/windows/SotyAgentHost/TrayApplication.cs', 'utf8'),
      readFile('packaging/windows/SotyAgentHost/FirstLaunch.cs', 'utf8')
    ]);
    const startup = between(
      tray,
      'private async Task StartupAsync()',
      '// MARK: Single-instance lock'
    );
    expect(startup.indexOf('openSiteWhenReady = DecideFirstLaunch()')).toBeGreaterThan(
      startup.indexOf('if (AcquireInstanceLock())')
    );
    expect(startup.indexOf('openSiteWhenReady = DecideFirstLaunch()')).toBeLessThan(
      startup.indexOf('StartAgentWhenPortIsFreeAsync()')
    );
    const readiness = between(
      tray,
      'private async Task CheckReadinessAsync()',
      '// MARK: Installed-build monitoring'
    );
    expect(readiness).toContain('OpenSiteOnFirstLaunch()');
    expect(tray).toContain('FirstLaunch.SiteUrl(HostConfig.PublicSiteOrigin)');
    expect(tray).toContain('Environment.GetEnvironmentVariable("NO_OPEN") == "1"');
    expect(tray).toContain('Environment.GetEnvironmentVariable("AGENT_UPDATE_HANDOFF") == "1"');
    // The same marker and the same evidence of an earlier run as the Mac.
    expect(firstLaunch).toContain('"first-launch-site-opened"');
    expect(firstLaunch).toContain('"state.json", "session-token.json"');
  });

  it('the Windows installer still offers "Start Soty", ticked by default', async () => {
    const installer = await readFile('packaging/windows-installer.iss', 'utf8');
    const run = installer.slice(installer.indexOf('[Run]'), installer.indexOf('[UninstallRun]'));
    expect(run).toContain('Description: "Start Soty"');
    expect(run).toContain('postinstall');
    expect(run).not.toContain('unchecked');
  });
});

describeRequiring(requirePlatform('darwin'), 'compiled first-launch decision', () => {
  it('opens once for a new user, never for an update, a second start or a suppressed one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'first-launch-'));
    try {
      const template = await readFile('packaging/Launcher.swift', 'utf8');
      const block = between(template, '// First launch:', '// End first launch.');
      const source = path.join(root, 'fixture.swift');
      const binary = path.join(root, 'fixture');
      await writeFile(
        source,
        `import Foundation
import Darwin
${block}
func require(_ condition: Bool, _ code: String) { if !condition { fputs(code + "\\n", stderr); exit(2) } }
let manager = FileManager.default
let root = URL(fileURLWithPath: CommandLine.arguments[1])
func directory(_ name: String) -> URL { root.appendingPathComponent(name, isDirectory: true) }
func write(_ name: String, in folder: URL) {
  try! manager.createDirectory(at: folder, withIntermediateDirectories: true)
  try! Data("{}".utf8).write(to: folder.appendingPathComponent(name))
}

let fresh = directory("fresh")
require(claimFirstLaunch(directory: fresh, suppressed: false), "NEW_USER_NOT_OPENED")
require(!claimFirstLaunch(directory: fresh, suppressed: false), "SECOND_START_OPENED")
require(manager.fileExists(atPath: fresh.appendingPathComponent("first-launch-site-opened").path), "MARKER_MISSING")

let updated = directory("updated"); write("state.json", in: updated)
require(!claimFirstLaunch(directory: updated, suppressed: false), "UPDATE_OPENED")
try! manager.removeItem(at: updated.appendingPathComponent("state.json"))
require(!claimFirstLaunch(directory: updated, suppressed: false), "ANSWER_NOT_RECORDED")

let paired = directory("paired"); write("session-token.json", in: paired)
require(!claimFirstLaunch(directory: paired, suppressed: false), "PAIRED_INSTALL_OPENED")

let verification = directory("verification")
require(!claimFirstLaunch(directory: verification, suppressed: true), "SUPPRESSED_OPENED")
// A verification run leaves the real first start untouched.
require(claimFirstLaunch(directory: verification, suppressed: false), "SUPPRESSION_CONSUMED_FIRST_START")

let locked = directory("locked")
try! manager.createDirectory(at: locked, withIntermediateDirectories: true)
try! manager.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked.path)
require(!claimFirstLaunch(directory: locked, suppressed: false), "UNWRITABLE_OPENED")
try! manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path)

require(firstLaunchSiteURL(origin: "https://soty.pp.ua")?.absoluteString == "https://soty.pp.ua/team", "PROD_URL")
require(firstLaunchSiteURL(origin: "https://next.soty.pp.ua")?.absoluteString == "https://next.soty.pp.ua/team", "NEXT_URL")
require(firstLaunchSiteURL(origin: "http://127.0.0.1:43140")?.absoluteString == "http://127.0.0.1:43140/team", "BETA_URL")
require(firstLaunchSiteURL(origin: "") == nil, "EMPTY_ORIGIN")
require(firstLaunchSiteURL(origin: "file:///etc") == nil, "FILE_ORIGIN")

let manifests: [String: Any] = [
  "SotyUpdateManifestURL": "https://soty.pp.ua/.well-known/wishly/stable.json",
  "SotyUpdateNextManifestURL": "https://next.soty.pp.ua/.well-known/wishly/stable.json"
]
require(firstLaunchSiteOrigin(built: "https://soty.pp.ua", info: manifests, preference: nil) == "https://soty.pp.ua", "NO_OPT_IN_STAYS_PROD")
require(firstLaunchSiteOrigin(built: "https://soty.pp.ua", info: manifests, preference: "next") == "https://next.soty.pp.ua", "OPT_IN_OPENS_NEXT")
require(firstLaunchSiteOrigin(built: "https://soty.pp.ua", info: manifests, preference: "beta") == "https://soty.pp.ua", "OTHER_PREFERENCE_STAYS_PROD")
require(firstLaunchSiteOrigin(built: "http://127.0.0.1:43140", info: manifests, preference: "next") == "http://127.0.0.1:43140", "BETA_NEVER_LEAVES")
var damaged = manifests; damaged["SotyUpdateNextManifestURL"] = "https://evil.test/x.json"
require(firstLaunchSiteOrigin(built: "https://soty.pp.ua", info: damaged, preference: "next") == "https://soty.pp.ua", "DAMAGED_NEXT_STAYS_PROD")
require(firstLaunchSiteOrigin(built: "https://soty.pp.ua", info: [:], preference: "next") == "https://soty.pp.ua", "NO_MANIFESTS_STAYS_PROD")
print("OK")
`
      );
      execFileSync('swiftc', [source, '-o', binary], { timeout: 120000, stdio: 'pipe' });
      const output = execFileSync(binary, [path.join(root, 'support')], {
        timeout: 10000,
        encoding: 'utf8'
      });
      expect(output.trim()).toBe('OK');
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
});
