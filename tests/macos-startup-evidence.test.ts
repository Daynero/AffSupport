import { removeTemporaryDirectory } from './support/temp-dir.js';
import { describeRequiring, requirePlatform } from './support/requires.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readStartupEvidence,
  sanitizeStartupEvidence
} from '../apps/agent/src/server/startup-evidence';
const row = {
  schemaVersion: 1,
  attemptId: '00000000-0000-4000-8000-000000000001',
  timeMs: Date.now(),
  stage: 'boot',
  code: 'STARTUP_BEGIN',
  architecture: 'x64',
  buildId: '1.3.3+79'
};
describe('bounded local preboot evidence', () => {
  it('drops raw/private fields and never upgrades an interrupted record into success', async () => {
    expect(
      sanitizeStartupEvidence([{ ...row, path: '/private/user-content', stderr: 'secret' }])
    ).toEqual([row]);
    expect(sanitizeStartupEvidence([{ ...row, buildId: '/Users/private' }])).toEqual([]);
    const root = await mkdtemp(path.join(os.tmpdir(), 'startup-evidence-'));
    try {
      const file = path.join(root, 'evidence.json');
      expect(await readStartupEvidence(file)).toMatchObject({ status: 'insufficient' });
      await writeFile(file, JSON.stringify([row]));
      expect(await readStartupEvidence(file)).toMatchObject({
        outcome: 'insufficient',
        lastProvenStage: 'boot'
      });
      await writeFile(
        file,
        JSON.stringify([{ ...row, stage: 'runtime_check', code: 'STARTUP_NODE_MISSING' }])
      );
      expect(await readStartupEvidence(file)).toMatchObject({ outcome: 'failed_or_interrupted' });
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
});
describeRequiring(requirePlatform('darwin'), 'compiled native startup producer', () => {
  it('rejects late, uncorrelated and dead-child health responses in the production readiness method', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-readiness-'));
    const namespace = `Soty Verification-native-${path.basename(root)}`;
    const support = path.join(os.homedir(), 'Library/Application Support', namespace);
    try {
      const template = await readFile('packaging/Launcher.swift', 'utf8');
      const block = template.slice(
        template.indexOf('// Native startup evidence:'),
        template.indexOf('// End native startup evidence.') +
          '// End native startup evidence.'.length
      );
      const health = template
        .slice(
          template.indexOf('private struct AgentHealth:'),
          template.indexOf('private struct InstalledRelease:')
        )
        .replace('private struct AgentHealth:', 'struct AgentHealth:');
      const readiness = template
        .slice(
          template.indexOf('  private func checkReadiness() {'),
          template.indexOf('  private func beginInstalledBuildMonitoring()')
        )
        .replace('private func checkReadiness()', 'func checkReadiness()');
      const source = path.join(root, 'fixture.swift');
      const binary = path.join(root, 'fixture');
      await writeFile(
        source,
        `import Foundation
import Darwin
let supportDirectoryName="${namespace}"
let expectedBuildID="fixture+1"
${block}
${health}
class FakeApplication { func terminate(_ value: Any?) {} }
let NSApp=FakeApplication()
class FixtureDelegate {
  var readinessAttempts=0
  var isTerminating=false
  var nativeStartupAttempt=UUID()
  var agentReady=false
  var failureCount=0
  var readinessTimer:Timer?
  var stderrText=""
  var process:Process?
  var pending:((AgentHealth?)->Void)?
  func probeHealth(timeout:TimeInterval,completion:@escaping(AgentHealth?)->Void) { pending=completion }
  func matchesExpectedBuild(_ health:AgentHealth)->Bool { true }
  func shouldReplaceWithExpectedBuild(_ health:AgentHealth)->Bool { false }
  func beginBusyMonitoring() {}
  func flushFinderActions() {}
  func scheduleFinderIntegrationOffer() {}
  func waitForPreviousAgent(_ health:AgentHealth) {}
  func portIsOccupied()->Bool { false }
  func waitForPortToBecomeAvailable() {}
  func showFailure(_ text:String,details:String) { failureCount += 1 }
${readiness}
}
func observed(_ attempt:UUID?)->AgentHealth {
  var value:[String:Any]=["product":"local-video-compressor-agent","ready":true]
  if let attempt { value["nativeStartupId"]=attempt.uuidString.lowercased() }
  return try! JSONDecoder().decode(AgentHealth.self,from:JSONSerialization.data(withJSONObject:value))
}
func require(_ condition:Bool,_ code:String) { if !condition { fputs(code+"\\n",stderr); if child.isRunning { child.terminate();child.waitUntilExit() }; exit(2) } }
let child=Process(); child.executableURL=URL(fileURLWithPath:"/bin/sleep"); child.arguments=["20"]
try child.run()
defer { if child.isRunning { child.terminate();child.waitUntilExit() } }
let delegate=FixtureDelegate();delegate.process=child
let previous=delegate.nativeStartupAttempt
delegate.checkReadiness();let late=delegate.pending!
delegate.nativeStartupAttempt=UUID()
late(observed(previous))
require(!delegate.agentReady,"STALE_STARTUP_RESPONSE_ACCEPTED")
delegate.checkReadiness();delegate.pending!(observed(nil))
require(!delegate.agentReady,"MISSING_STARTUP_ID_ACCEPTED")
delegate.checkReadiness();delegate.pending!(observed(previous))
require(!delegate.agentReady,"WRONG_STARTUP_ID_ACCEPTED")
delegate.readinessAttempts=59
delegate.checkReadiness();delegate.pending!(observed(nil))
require(!delegate.agentReady && delegate.failureCount == 1,"UNPROVEN_STARTUP_TIMEOUT_IGNORED")
delegate.readinessAttempts=0
delegate.checkReadiness();delegate.pending!(observed(delegate.nativeStartupAttempt))
require(delegate.agentReady,"CURRENT_LIVE_STARTUP_REFUSED")
child.terminate();child.waitUntilExit();delegate.agentReady=false
delegate.checkReadiness();delegate.pending!(observed(delegate.nativeStartupAttempt))
require(!delegate.agentReady,"DEAD_CHILD_RESPONSE_ACCEPTED")
`
      );
      execFileSync('swiftc', [source, '-o', binary], { timeout: 30000, stdio: 'pipe' });
      execFileSync(binary, [], { timeout: 10000, stdio: 'pipe' });
      const evidence = await readStartupEvidence(path.join(support, 'native-startup.json'));
      expect(evidence.records.map(record => record.code)).toEqual(['STARTUP_READY']);
      expect(evidence).toMatchObject({ outcome: 'ready' });
    } finally {
      await removeTemporaryDirectory(root);
      await removeTemporaryDirectory(support);
    }
  }, 60000);
  it('records real missing, foreign-CPU and interrupted boot faults without GUI or user content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-startup-'));
    const namespace = `Soty Verification-native-${path.basename(root)}`;
    const support = path.join(os.homedir(), 'Library/Application Support', namespace);
    try {
      const template = await readFile('packaging/Launcher.swift', 'utf8');
      const block = template.slice(
        template.indexOf('// Native startup evidence:'),
        template.indexOf('// End native startup evidence.') +
          '// End native startup evidence.'.length
      );
      const source = path.join(root, 'fixture.swift');
      const binary = path.join(root, 'fixture');
      await writeFile(
        source,
        `import Foundation\nimport Darwin\nlet supportDirectoryName="${namespace}"\nlet expectedBuildID="fixture+1"\n${block}\nlet attempt=UUID()\nrecordNativeStartup(.boot,.begin,attempt)\nif !FileManager.default.isExecutableFile(atPath:"${root}/missing-node") { recordNativeStartup(.runtime_check,.nodeMissing,attempt) }\nlet foreign=URL(fileURLWithPath:"${root}/foreign-node")\nlet words:[UInt32]=[0xfeedface,12,0,2,0,0,0]\ntry words.withUnsafeBytes { try Data($0).write(to:foreign) }\ntry FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:foreign.path)\nlet foreignChild=Process();foreignChild.executableURL=foreign\ndo { try foreignChild.run(); foreignChild.waitUntilExit(); fatalError("Foreign CPU unexpectedly executed") } catch { recordNativeStartup(.spawn,nativeStartupFailureCode(error),UUID()) }\nlet interrupted=Process();interrupted.executableURL=URL(fileURLWithPath:"/bin/sleep");interrupted.arguments=["5"]\ntry interrupted.run()\nrecordInterruptedNativeStartup(interrupted,false,UUID())\ninterrupted.terminate();interrupted.waitUntilExit()\n`
      );
      execFileSync('swiftc', [source, '-o', binary], { timeout: 30000, stdio: 'pipe' });
      execFileSync(binary, [], { timeout: 10000, stdio: 'pipe' });
      const result = await readStartupEvidence(path.join(support, 'native-startup.json'));
      expect(result).toMatchObject({ status: 'observed', terminal: 'STARTUP_INTERRUPTED' });
      expect(result.records.map(record => record.code)).toEqual([
        'STARTUP_BEGIN',
        'STARTUP_NODE_MISSING',
        'STARTUP_WRONG_ARCHITECTURE',
        'STARTUP_INTERRUPTED'
      ]);
      const bytes = await readFile(path.join(support, 'native-startup.json'), 'utf8');
      expect(bytes).not.toContain(root);
      const cliText = execFileSync(
        'npm',
        [
          'run',
          '--silent',
          'analytics',
          '--',
          'startup',
          path.join(support, 'native-startup.json'),
          '--period',
          'all',
          '--json'
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, ANALYTICS_DATABASE_URL: '' },
          timeout: 15000,
          stdio: 'pipe'
        }
      );
      const diagnosis = JSON.parse(cliText);
      expect(diagnosis).toMatchObject({
        ok: true,
        command: 'startup',
        data: { status: 'observed', lastProvenStage: 'terminal', outcome: 'failed_or_interrupted' }
      });
      expect(JSON.stringify(diagnosis.data.findings)).toContain('packaging/Launcher.swift');
      expect(cliText).not.toContain(support);
    } finally {
      await removeTemporaryDirectory(root);
      await removeTemporaryDirectory(support);
    }
  }, 60000);
});
