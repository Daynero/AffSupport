import AppKit
import Darwin
import Foundation

private let agentPort = __AGENT_PORT__
private let agentBaseURL = URL(string: "http://127.0.0.1:\(agentPort)")!
private let applicationName = "__APP_NAME__"
private let instanceLockName = "__INSTANCE_LOCK_NAME__"
private let supportDirectoryName = "__SUPPORT_DIRECTORY_NAME__"
private let expectedVersion = "__APP_VERSION__"
private let expectedBuildNumber = "__BUILD_NUMBER__"
private let expectedBuildID = "__BUILD_ID__"
private let expectedAPIVersion = __API_VERSION__
private let releaseChannel = "__RELEASE_CHANNEL__"
private let sourceRevision = "__SOURCE_REVISION__"

private struct AgentHealth: Decodable {
  let product: String
  let ready: Bool
  let version: String?
  let buildNumber: String?
  let buildId: String?
  let apiVersion: Int?
  let sourceRevision: String?
  let busy: Bool?
}

private struct InstalledRelease: Decodable {
  let buildId: String
  let sourceRevision: String
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var process: Process?
  private var stderrText = ""
  private var readinessTimer: Timer?
  private var handoffTimer: Timer?
  private var updateMonitorTimer: Timer?
  private var readinessAttempts = 0
  private var handoffAttempts = 0
  private var portWaitAttempts = 0
  private var openedInterface = false
  private var statusItem: NSStatusItem?
  private var lockFD: Int32 = -1
  private var isTerminating = false
  private var restartingIntoInstalledBuild = false
  private var warnedInstalledBuildID: String?
  private var runtimeRestartAttempts = 0

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard installedLocationAllowed() else {
      showFailure(
        "Move Wishly Agent to Applications before opening it.",
        details: "Running directly from a DMG or Downloads can make the bundled media tools disappear while a video is being processed. Drag Wishly Agent to Applications, then open that installed copy."
      )
      return
    }
    installMenuBarItem()
    beginInstalledBuildMonitoring()
    if acquireInstanceLock() {
      startAgentWhenPortIsFree()
    } else if ProcessInfo.processInfo.environment["AGENT_UPDATE_HANDOFF"] == "1" {
      beginHandoff()
    } else {
      handleExistingInstance()
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    isTerminating = true
    readinessTimer?.invalidate()
    handoffTimer?.invalidate()
    updateMonitorTimer?.invalidate()
    if let process, process.isRunning {
      process.terminate()
      process.waitUntilExit()
    }
    return .terminateNow
  }

  private func installedLocationAllowed() -> Bool {
    if releaseChannel != "stable" ||
        ProcessInfo.processInfo.environment["WISHLY_ALLOW_UNINSTALLED_AGENT"] == "1" {
      return true
    }
    let path = Bundle.main.bundleURL.resolvingSymlinksInPath().standardizedFileURL.path
    let roots = ["/Applications", FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Applications").path]
    return roots.contains { path.hasPrefix($0 + "/") }
  }

  private func acquireInstanceLock() -> Bool {
    if lockFD >= 0 { return true }
    let lockURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(instanceLockName)
    let candidate = Darwin.open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard candidate >= 0 else { return false }
    guard flock(candidate, LOCK_EX | LOCK_NB) == 0 else {
      Darwin.close(candidate)
      return false
    }
    lockFD = candidate
    return true
  }

  private func installMenuBarItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = NSImage(
      systemSymbolName: "film.stack",
      accessibilityDescription: applicationName
    )
    let menu = NSMenu()
    let openItem = menu.addItem(
      withTitle: "Open Wishly",
      action: #selector(openInterface),
      keyEquivalent: "o"
    )
    openItem.target = self
    let versionItem = menu.addItem(
      withTitle: "Version \(expectedVersion) · build \(expectedBuildNumber)",
      action: nil,
      keyEquivalent: ""
    )
    versionItem.isEnabled = false
    menu.addItem(.separator())
    let quitItem = menu.addItem(
      withTitle: "Quit \(applicationName)",
      action: #selector(quit),
      keyEquivalent: "q"
    )
    quitItem.target = self
    item.menu = menu
    statusItem = item
  }

  private func handleExistingInstance(attempt: Int = 0) {
    probeHealth(timeout: 0.5) { [weak self] health in
      guard let self else { return }
      guard let health else {
        if attempt < 20 {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.handleExistingInstance(attempt: attempt + 1)
          }
          return
        }
        self.showFailure(
          "Another copy owns the Agent lock but is not responding.",
          details: "Quit the existing menu bar Agent and open version \(expectedVersion) again."
        )
        return
      }
      if self.matchesExpectedBuild(health) {
        if health.ready {
          self.openInterface()
          NSApp.terminate(nil)
        } else if attempt < 20 {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.handleExistingInstance(attempt: attempt + 1)
          }
        } else {
          self.showFailure(
            "The existing Agent did not become ready.",
            details: "Running: \(self.describe(health))."
          )
        }
        return
      }
      self.offerRunningVersionRestart(health)
    }
  }

  private func offerRunningVersionRestart(_ health: AgentHealth) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Restart the updated Agent?"
    alert.informativeText = """
      A different Agent build is still running (\(describe(health))).
      Installed: \(expectedVersion), build \(expectedBuildNumber), API \(expectedAPIVersion).

      Restarting activates the installed update. An active compression would be marked interrupted and can be retried safely.
      """
    alert.addButton(withTitle: "Restart Agent")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else {
      NSApp.terminate(nil)
      return
    }

    let ownPID = ProcessInfo.processInfo.processIdentifier
    let others = NSRunningApplication
      .runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "local.video.compressor.test")
      .filter { $0.processIdentifier != ownPID }
    for application in others { _ = application.terminate() }
    beginHandoff()
  }

  private func beginHandoff() {
    handoffAttempts = 0
    handoffTimer?.invalidate()
    handoffTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.continueHandoff()
    }
    continueHandoff()
  }

  private func continueHandoff() {
    guard !isTerminating else { return }
    handoffAttempts += 1
    if acquireInstanceLock() {
      handoffTimer?.invalidate()
      handoffTimer = nil
      portWaitAttempts = 0
      startAgentWhenPortIsFree()
    } else if handoffAttempts >= 48 {
      handoffTimer?.invalidate()
      showFailure(
        "The previous Agent did not stop.",
        details: "Quit it from the menu bar (or Force Quit), then open version \(expectedVersion) again."
      )
    }
  }

  private func startAgentWhenPortIsFree() {
    probeHealth(timeout: 0.35) { [weak self] health in
      guard let self, !self.isTerminating else { return }
      guard health == nil else {
        self.portWaitAttempts += 1
        if self.portWaitAttempts < 24 {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.startAgentWhenPortIsFree()
          }
        } else {
          self.showFailure(
            "An old Agent process is still using port 43120.",
            details: "Running: \(self.describe(health!)). Quit the old Agent and try again."
          )
        }
        return
      }
      self.spawnAgent()
    }
  }

  private func probeHealth(
    timeout: TimeInterval,
    completion: @escaping (AgentHealth?) -> Void
  ) {
    var request = URLRequest(url: agentBaseURL.appendingPathComponent("health"))
    request.timeoutInterval = timeout
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let statusOK = (response as? HTTPURLResponse)?.statusCode == 200
      let health = statusOK
        ? data.flatMap { try? JSONDecoder().decode(AgentHealth.self, from: $0) }
        : nil
      let recognized = health?.product == "local-video-compressor-agent" ? health : nil
      DispatchQueue.main.async { completion(recognized) }
    }.resume()
  }

  private func matchesExpectedBuild(_ health: AgentHealth) -> Bool {
    health.buildId == expectedBuildID &&
      health.apiVersion == expectedAPIVersion &&
      health.sourceRevision == sourceRevision
  }

  private func describe(_ health: AgentHealth) -> String {
    let version = health.version ?? "legacy version"
    let build = health.buildNumber.map { "build \($0)" } ?? "unknown build"
    let api = health.apiVersion.map(String.init) ?? "unknown"
    let revision = health.sourceRevision.map { String($0.prefix(12)) } ?? "unknown source"
    return "\(version), \(build), API \(api), source \(revision)"
  }

  private func spawnAgent() {
    let resources = Bundle.main.resourceURL!
    let executable = resources.appendingPathComponent("runtime/node")
    let ffmpeg = resources.appendingPathComponent("runtime/bin/ffmpeg")
    let ffprobe = resources.appendingPathComponent("runtime/bin/ffprobe")
    let agentDirectory = resources.appendingPathComponent("agent")
    let entry = agentDirectory.appendingPathComponent("dist/index.js")
    guard [executable, ffmpeg, ffprobe].allSatisfy({
      FileManager.default.isExecutableFile(atPath: $0.path)
    }) else {
      showFailure(
        "The bundled media runtime is unavailable.",
        details: "Reinstall Wishly Agent in Applications. Your local queue and original files are safe."
      )
      return
    }
    let child = Process()
    let output = Pipe()
    child.executableURL = executable
    child.arguments = [entry.path]
    child.currentDirectoryURL = agentDirectory
    child.standardOutput = output
    child.standardError = output
    child.environment = ProcessInfo.processInfo.environment.merging([
      "PACKAGED_APP": "1",
      "NO_OPEN": "1",
      "AGENT_PORT": String(agentPort),
      "AGENT_SUPPORT_DIRECTORY_NAME": supportDirectoryName,
      "PUBLIC_SITE_ORIGIN": "__PUBLIC_SITE_ORIGIN__",
      "AGENT_VERSION": expectedVersion,
      "AGENT_BUILD_NUMBER": expectedBuildNumber,
      "AGENT_BUILD_ID": expectedBuildID,
      "AGENT_RELEASE_CHANNEL": releaseChannel,
      "AGENT_SOURCE_REVISION": sourceRevision,
      "AGENT_INSTALLED_RELEASE_PATH": resources.appendingPathComponent("release.json").path
    ]) { _, packaged in packaged }
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      guard let text = String(data: handle.availableData, encoding: .utf8), !text.isEmpty else { return }
      DispatchQueue.main.async {
        self?.stderrText = String(((self?.stderrText ?? "") + text).suffix(12_000))
      }
    }
    child.terminationHandler = { [weak self] finished in
      DispatchQueue.main.async {
        guard let self, !self.isTerminating else { return }
        self.readinessTimer?.invalidate()
        if finished.terminationStatus == 75 && self.runtimeRestartAttempts < 2 {
          self.runtimeRestartAttempts += 1
          self.process = nil
          self.portWaitAttempts = 0
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
            guard !self.isTerminating else { return }
            self.startAgentWhenPortIsFree()
          }
          return
        }
        self.showFailure(
          "The local agent exited with status \(finished.terminationStatus).",
          details: self.stderrText
        )
      }
    }
    do {
      try child.run()
      process = child
      beginReadinessChecks()
    } catch {
      showFailure("The bundled agent runtime could not be started.", details: error.localizedDescription)
    }
  }

  private func beginReadinessChecks() {
    readinessAttempts = 0
    readinessTimer?.invalidate()
    readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.checkReadiness()
    }
    checkReadiness()
  }

  private func checkReadiness() {
    readinessAttempts += 1
    probeHealth(timeout: 1) { [weak self] health in
      guard let self, !self.openedInterface, !self.isTerminating else { return }
      if let health, self.matchesExpectedBuild(health), health.ready {
        self.readinessTimer?.invalidate()
        self.openedInterface = true
        if ProcessInfo.processInfo.environment["NO_OPEN"] != "1" { self.openInterface() }
      } else if let health, !self.matchesExpectedBuild(health) {
        self.readinessTimer?.invalidate()
        self.showFailure(
          "A different Agent answered the readiness check.",
          details: "Running: \(self.describe(health)); expected build \(expectedBuildID)."
        )
      } else if self.readinessAttempts >= 60 {
        self.readinessTimer?.invalidate()
        self.showFailure("The local agent did not become ready.", details: self.stderrText)
      }
    }
  }

  private func beginInstalledBuildMonitoring() {
    updateMonitorTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      self?.checkInstalledBuild()
    }
  }

  private func checkInstalledBuild() {
    guard !isTerminating, !restartingIntoInstalledBuild,
          let releaseURL = Bundle.main.resourceURL?.appendingPathComponent("release.json"),
          let data = try? Data(contentsOf: releaseURL),
          let installed = try? JSONDecoder().decode(InstalledRelease.self, from: data),
          installed.buildId != expectedBuildID || installed.sourceRevision != sourceRevision else { return }

    probeHealth(timeout: 1) { [weak self] health in
      guard let self, !self.isTerminating, !self.restartingIntoInstalledBuild else { return }
      if health?.busy == false {
        self.restartIntoInstalledBuild()
      } else {
        let installedIdentity = "\(installed.buildId) · \(installed.sourceRevision.prefix(12))"
        if self.warnedInstalledBuildID != installedIdentity {
          self.warnedInstalledBuildID = installedIdentity
          self.offerInstalledBuildRestart(installedIdentity)
        }
      }
    }
  }

  private func offerInstalledBuildRestart(_ installedBuildID: String) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = "An Agent update was installed"
    alert.informativeText = "Restart now to activate build \(installedBuildID). If compression is active, you can finish it first; the Agent will restart automatically afterward."
    alert.addButton(withTitle: "Restart Now")
    alert.addButton(withTitle: "After Compression")
    if alert.runModal() == .alertFirstButtonReturn { restartIntoInstalledBuild() }
  }

  private func restartIntoInstalledBuild() {
    guard !restartingIntoInstalledBuild else { return }
    restartingIntoInstalledBuild = true
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.environment = ProcessInfo.processInfo.environment.merging([
      "AGENT_UPDATE_HANDOFF": "1"
    ]) { _, handoff in handoff }
    NSWorkspace.shared.openApplication(
      at: Bundle.main.bundleURL,
      configuration: configuration
    ) { [weak self] _, error in
      DispatchQueue.main.async {
        guard let self else { return }
        if let error {
          self.restartingIntoInstalledBuild = false
          self.showFailure("The installed update could not be restarted.", details: error.localizedDescription)
        } else {
          NSApp.terminate(nil)
        }
      }
    }
  }

  // The packaged web interface and Agent are built from the same contract. Opening the
  // loopback copy makes UI/Agent updates atomic and also avoids browser private-network rules.
  @objc private func openInterface() {
    NSWorkspace.shared.open(agentBaseURL.appendingPathComponent("local"))
  }

  @objc private func quit() { NSApp.terminate(nil) }

  private func showFailure(_ message: String, details: String) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "\(applicationName) could not start"
    alert.informativeText = details.isEmpty ? message : "\(message)\n\n\(details)"
    alert.addButton(withTitle: "Quit")
    alert.runModal()
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
