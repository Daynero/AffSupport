import AppKit
import Darwin
import FinderSync
import Foundation
import OSLog

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
private let nativeToken = [UUID(), UUID()].map(\.uuidString).joined()
private let finderActionPasteboardType = NSPasteboard.PasteboardType("com.wishly.finder-action")
private let finderIntegrationOfferKey = "didOfferFinderImageConversionV1"
private let launcherLogger = Logger(
  subsystem: Bundle.main.bundleIdentifier ?? "SotyAgent",
  category: "finder-actions"
)
private let updateHandoffExitStatus: Int32 = 76

/// The Finder bridge token changes every time the native host starts, so it
/// cannot be used by a newly installed host to reach an older Agent. Keep a
/// separate, user-private token in Application Support for the narrow update
/// drain endpoint. It has no filesystem or tool privileges.
private func validUpdateHandoffToken(_ raw: String) -> String? {
  let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard
    token.count >= 64,
    token.count <= 160,
    token.allSatisfy({ character in
      character.isASCII && (character.isLetter || character.isNumber || character == "-")
    })
  else { return nil }
  return token
}

private func readUpdateHandoffToken(at url: URL) -> String? {
  guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
  return validUpdateHandoffToken(raw)
}

private func createUpdateHandoffToken(_ token: String, at url: URL) -> Bool {
  let descriptor = url.path.withCString {
    Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
  }
  guard descriptor >= 0 else { return false }
  let bytes = Array((token + "\n").utf8)
  let wroteAll = bytes.withUnsafeBytes { buffer -> Bool in
    guard let base = buffer.baseAddress else { return false }
    var offset = 0
    while offset < buffer.count {
      let written = Darwin.write(descriptor, base.advanced(by: offset), buffer.count - offset)
      guard written > 0 else { return false }
      offset += Int(written)
    }
    return true
  }
  Darwin.close(descriptor)
  if !wroteAll { _ = Darwin.unlink(url.path) }
  return wroteAll
}

private func loadOrCreateUpdateHandoffToken() -> String? {
  let manager = FileManager.default
  guard
    let root = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
  else { return nil }
  let directory = root.appendingPathComponent(supportDirectoryName, isDirectory: true)
  do {
    try manager.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
  } catch {
    return nil
  }
  let tokenURL = directory.appendingPathComponent("agent-update-handoff-token")
  if let token = readUpdateHandoffToken(at: tokenURL) { return token }
  let token = [UUID(), UUID()].map(\.uuidString).joined()
  if createUpdateHandoffToken(token, at: tokenURL) { return token }
  // A second launcher may have created the token between our read and O_EXCL.
  return readUpdateHandoffToken(at: tokenURL)
}

private let updateHandoffToken = loadOrCreateUpdateHandoffToken()

/// A compact, monochrome honeycomb mark for the macOS menu bar.  Template
/// images let AppKit choose the correct foreground colour for light and dark
/// menu bars while retaining the intentionally uneven half-fill.
///
/// While a tool is working the static fill is replaced by an equalizer: thin
/// bars inside the same cell whose heights come from `levels` (each 0...1).
private func honeycombStatusImage(
  accessibilityDescription: String,
  levels: [CGFloat]? = nil
) -> NSImage {
  let image = NSImage(size: NSSize(width: 18, height: 18))
  image.lockFocus()
  defer { image.unlockFocus() }

  let hexagon = NSBezierPath()
  hexagon.move(to: NSPoint(x: 9, y: 1.2))
  hexagon.line(to: NSPoint(x: 15.5, y: 4.95))
  hexagon.line(to: NSPoint(x: 15.5, y: 13.05))
  hexagon.line(to: NSPoint(x: 9, y: 16.8))
  hexagon.line(to: NSPoint(x: 2.5, y: 13.05))
  hexagon.line(to: NSPoint(x: 2.5, y: 4.95))
  hexagon.close()

  NSGraphicsContext.saveGraphicsState()
  hexagon.addClip()
  NSColor.black.setFill()
  if let levels, !levels.isEmpty {
    let barWidth: CGFloat = 1.5
    let gap: CGFloat = 1.05
    let span = CGFloat(levels.count) * barWidth + CGFloat(levels.count - 1) * gap
    let baseline: CGFloat = 5.1
    let shortest: CGFloat = 2.1
    let tallest: CGFloat = 7.9
    var x = 9 - span / 2
    for level in levels {
      let height = shortest + (tallest - shortest) * min(max(level, 0), 1)
      NSBezierPath(
        roundedRect: NSRect(x: x, y: baseline, width: barWidth, height: height),
        xRadius: barWidth / 2,
        yRadius: barWidth / 2
      ).fill()
      x += barWidth + gap
    }
  } else {
    // Keep the lower portion visibly organic rather than splitting the cell
    // along a perfectly level line.
    let fill = NSBezierPath()
    fill.move(to: NSPoint(x: 2.5, y: 9.35))
    fill.line(to: NSPoint(x: 4.75, y: 8.85))
    fill.line(to: NSPoint(x: 6.7, y: 9.6))
    fill.line(to: NSPoint(x: 8.8, y: 7.95))
    fill.line(to: NSPoint(x: 11, y: 8.75))
    fill.line(to: NSPoint(x: 12.65, y: 8.15))
    fill.line(to: NSPoint(x: 15.5, y: 10.5))
    fill.line(to: NSPoint(x: 15.5, y: 13.05))
    fill.line(to: NSPoint(x: 9, y: 16.8))
    fill.line(to: NSPoint(x: 2.5, y: 13.05))
    fill.close()
    fill.fill()
  }
  NSGraphicsContext.restoreGraphicsState()

  hexagon.lineWidth = 1.35
  hexagon.lineJoinStyle = .round
  NSColor.black.setStroke()
  hexagon.stroke()

  image.isTemplate = true
  image.accessibilityDescription = accessibilityDescription
  return image
}

private struct AgentHealth: Decodable {
  let product: String
  let ready: Bool
  let buildId: String?
  let apiVersion: Int?
  let sourceRevision: String?
  let busy: Bool?
}

private struct InstalledRelease: Decodable {
  let buildId: String
  let sourceRevision: String
}

private struct FinderActionPayload: Codable {
  let kind: String
  let format: String
  let paths: [String]
}

private struct FinderActionAcceptedJob: Decodable {
  let id: String
  let status: String
}

private struct FinderActionResponse: Decodable {
  let jobs: [FinderActionAcceptedJob]
}

private struct FinderActionJob: Decodable {
  let id: String
  let status: String
  let errorCode: String?
  let error: String?
}

private struct FinderActionStateResponse: Decodable {
  let jobs: [FinderActionJob]
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var process: Process?
  private var stderrText = ""
  private var readinessTimer: Timer?
  private var handoffTimer: Timer?
  private var updateMonitorTimer: Timer?
  private var updateWaitTimer: Timer?
  private var readinessAttempts = 0
  private var handoffAttempts = 0
  private var portWaitAttempts = 0
  private var waitingForPreviousAgent = false
  private var portOwnerStopRequested = false
  private var updateDrainRequestInFlight = false
  private var installedUpdatePending = false
  private var statusItem: NSStatusItem?
  private var lockFD: Int32 = -1
  private var isTerminating = false
  private var restartingIntoInstalledBuild = false
  private var runtimeRestartAttempts = 0
  private var pendingFinderActions: [FinderActionPayload] = []
  private var agentReady = false
  private var pendingFinderJobIDs = Set<String>()
  private var finderPollScheduled = false
  private var finderPollInFlight = false
  private var finderPollAttempts = 0
  private var lastFinderFailure: String?
  private var busyPollTimer: Timer?
  private var busyPollInFlight = false
  private var equalizerTimer: Timer?
  private var equalizerPhase: Double = 0
  private var agentBusy = false
  private weak var finderStatusItem: NSMenuItem?
  private weak var finderIntegrationItem: NSMenuItem?
  private weak var updateStatusItem: NSMenuItem?
  private weak var restartUpdateItem: NSMenuItem?

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard installedLocationAllowed() else {
      showFailure(
        "Move Soty to Applications before opening it.",
        details:
          "Running directly from a DMG or Downloads can make the bundled media tools disappear while a video is being processed. Drag Soty to Applications, then open that installed copy."
      )
      return
    }
    NSApp.servicesProvider = self
    NSUpdateDynamicServices()
    launcherLogger.notice(
      "Registered Finder action service provider for \(applicationName, privacy: .public)"
    )
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

  func applicationDidBecomeActive(_ notification: Notification) {
    updateFinderIntegrationItem()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    isTerminating = true
    readinessTimer?.invalidate()
    handoffTimer?.invalidate()
    updateMonitorTimer?.invalidate()
    updateWaitTimer?.invalidate()
    busyPollTimer?.invalidate()
    equalizerTimer?.invalidate()
    NSApp.servicesProvider = nil
    if let process, process.isRunning {
      process.terminate()
      process.waitUntilExit()
    }
    return .terminateNow
  }

  private func installedLocationAllowed() -> Bool {
    if releaseChannel != "stable"
      || ProcessInfo.processInfo.environment["WISHLY_ALLOW_UNINSTALLED_AGENT"] == "1"
    {
      return true
    }
    let path = Bundle.main.bundleURL.resolvingSymlinksInPath().standardizedFileURL.path
    let roots = [
      "/Applications",
      FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications").path,
    ]
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
    item.button?.image = honeycombStatusImage(accessibilityDescription: applicationName)
    let menu = NSMenu()
    let openItem = menu.addItem(
      withTitle: "Open Soty",
      action: #selector(openInterface),
      keyEquivalent: "o"
    )
    openItem.target = self
    let versionItem = menu.addItem(
      withTitle: "Version \(expectedVersion)",
      action: nil,
      keyEquivalent: ""
    )
    versionItem.isEnabled = false
    let updateItem = menu.addItem(
      withTitle: "",
      action: nil,
      keyEquivalent: ""
    )
    updateItem.isEnabled = false
    updateItem.isHidden = true
    updateStatusItem = updateItem
    let restartItem = menu.addItem(
      withTitle: "Restart Soty now…",
      action: #selector(restartSotyNow),
      keyEquivalent: ""
    )
    restartItem.target = self
    restartItem.isHidden = true
    restartUpdateItem = restartItem
    let integrationItem = menu.addItem(
      withTitle: "Enable Finder Conversion…",
      action: #selector(manageFinderIntegration),
      keyEquivalent: ""
    )
    integrationItem.target = self
    finderIntegrationItem = integrationItem
    updateFinderIntegrationItem()
    let finderItem = menu.addItem(
      withTitle: "Finder actions ready",
      action: #selector(showFinderFailureDetails),
      keyEquivalent: ""
    )
    finderItem.target = self
    finderItem.isHidden = true
    finderStatusItem = finderItem
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

  private func showUpdateStatus(_ message: String, canRestartNow: Bool) {
    updateStatusItem?.title = message
    updateStatusItem?.isHidden = false
    restartUpdateItem?.isHidden = !canRestartNow
  }

  private func clearUpdateStatus() {
    guard !installedUpdatePending, !waitingForPreviousAgent else { return }
    updateStatusItem?.isHidden = true
    restartUpdateItem?.isHidden = true
  }

  @objc private func restartSotyNow() {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = "Restart Soty now?"
    alert.informativeText =
      "Soty will close the previous local session. Any task still running will be marked as interrupted and can be retried safely."
    alert.addButton(withTitle: "Restart Now")
    alert.addButton(withTitle: "Keep Working")
    guard alert.runModal() == .alertFirstButtonReturn else { return }

    if installedUpdatePending {
      restartIntoInstalledBuild()
      return
    }
    waitingForPreviousAgent = true
    showUpdateStatus("Finishing the Soty update…", canRestartNow: true)
    forceStopPreviousAgent()
  }

  private func handleExistingInstance(attempt: Int = 0) {
    probeHealth(timeout: 0.5) { [weak self] health in
      guard let self, !self.isTerminating else { return }
      guard let health else {
        if attempt < 20 {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.handleExistingInstance(attempt: attempt + 1)
          }
        } else {
          self.waitingForPreviousAgent = true
          self.showUpdateStatus(
            "Soty is waiting for a previous session to close…",
            canRestartNow: false
          )
          self.beginHandoff()
        }
        return
      }
      if self.matchesExpectedBuild(health) {
        if health.ready {
          NSApp.terminate(nil)
        } else if attempt < 20 {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.handleExistingInstance(attempt: attempt + 1)
          }
        } else {
          self.showUpdateStatus("Soty is getting ready…", canRestartNow: false)
          DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.handleExistingInstance(attempt: 0)
          }
        }
        return
      }
      if self.shouldReplaceWithExpectedBuild(health) {
        self.waitForPreviousAgent(health)
      } else {
        NSApp.terminate(nil)
      }
    }
  }

  /// A legacy Agent can outlive its menu-bar host after a force quit. Never
  /// interrupt a task automatically: first ask a current Agent to drain using
  /// the private handoff protocol, then use the verified legacy fallback only
  /// once `/health` confirms it is idle.
  private func waitForPreviousAgent(_ health: AgentHealth) {
    waitingForPreviousAgent = true
    if health.busy != false {
      showUpdateStatus(
        health.busy == true
          ? "Soty will finish updating after the current task."
          : "Soty is preparing an update…",
        canRestartNow: true
      )
      // Current Agents understand a drain request even while work is active:
      // they finish it, refuse new tasks, and exit when every module is idle.
      // Older Agents simply reject the request, which leaves them untouched.
      requestPreviousAgentDrain(fallbackWhenIdle: false)
      beginPreviousAgentWait()
      return
    }

    showUpdateStatus("Finishing the Soty update…", canRestartNow: true)
    requestPreviousAgentDrain(fallbackWhenIdle: true)
  }

  private func requestPreviousAgentDrain(fallbackWhenIdle: Bool) {
    guard !portOwnerStopRequested, !updateDrainRequestInFlight else { return }
    guard let updateHandoffToken else {
      if fallbackWhenIdle { stopPreviousAgentAfterIdle() }
      return
    }
    updateDrainRequestInFlight = true
    var request = URLRequest(
      url: agentBaseURL.appendingPathComponent("native/update/drain")
    )
    request.httpMethod = "POST"
    request.timeoutInterval = 1
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(updateHandoffToken, forHTTPHeaderField: "X-Wishly-Update-Token")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["targetBuildId": expectedBuildID])
    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      let accepted = (response as? HTTPURLResponse)?.statusCode == 202
      DispatchQueue.main.async {
        guard let self, !self.isTerminating else { return }
        self.updateDrainRequestInFlight = false
        if accepted {
          self.portOwnerStopRequested = true
          self.beginPreviousAgentWait()
        } else if fallbackWhenIdle {
          self.stopPreviousAgentAfterIdle()
        }
      }
    }.resume()
  }

  private func stopPreviousAgentAfterIdle() {
    guard !portOwnerStopRequested else { return }
    portOwnerStopRequested = true
    terminateOtherHostInstances()
    // A legacy force-quit can leave only its Node child behind. It is safe to
    // stop only after both product health and the packaged command line match.
    _ = terminateVerifiedAgentListeningOnPort()
    beginPreviousAgentWait()
  }

  private func forceStopPreviousAgent() {
    portOwnerStopRequested = true
    terminateOtherHostInstances()
    _ = terminateVerifiedAgentListeningOnPort()
    beginPreviousAgentWait()
  }

  private func terminateOtherHostInstances() {
    let ownPID = ProcessInfo.processInfo.processIdentifier
    let others =
      NSRunningApplication
      .runningApplications(
        withBundleIdentifier: Bundle.main.bundleIdentifier ?? "local.video.compressor.test"
      )
      .filter { $0.processIdentifier != ownPID }
    for application in others { _ = application.terminate() }
  }

  private func terminateVerifiedAgentListeningOnPort() -> Bool {
    guard
      let pid = agentListenerPID(),
      pid != ProcessInfo.processInfo.processIdentifier,
      isBundledAgentProcess(pid)
    else { return false }
    let stopped = Darwin.kill(pid, SIGTERM) == 0 || errno == ESRCH
    if stopped {
      launcherLogger.notice("Requested graceful shutdown of legacy Agent PID \(pid, privacy: .public)")
    } else {
      launcherLogger.error("Could not stop legacy Agent PID \(pid, privacy: .public): errno \(errno, privacy: .public)")
    }
    return stopped
  }

  private func portListenerPIDs() -> Set<Int32> {
    guard
      let output = commandOutput(
        executable: "/usr/sbin/lsof",
        arguments: ["-nP", "-t", "-iTCP:\(agentPort)", "-sTCP:LISTEN"]
      )
    else { return [] }
    return Set(
      output
        .split(whereSeparator: { $0.isWhitespace })
        .compactMap { Int32(String($0)) }
        .filter { $0 > 1 }
    )
  }

  private func agentListenerPID() -> Int32? {
    let pids = portListenerPIDs()
    return pids.count == 1 ? pids.first : nil
  }

  private func portIsOccupied() -> Bool {
    !portListenerPIDs().isEmpty
  }

  private func isBundledAgentProcess(_ pid: Int32) -> Bool {
    guard
      let command = commandOutput(
        executable: "/bin/ps",
        arguments: ["-ww", "-p", String(pid), "-o", "command="]
      )
    else { return false }
    return command.contains("/Contents/Resources/runtime/node")
      && command.contains("/Contents/Resources/agent/dist/index.js")
  }

  private func commandOutput(executable: String, arguments: [String]) -> String? {
    let command = Process()
    command.executableURL = URL(fileURLWithPath: executable)
    command.arguments = arguments
    let output = Pipe()
    command.standardOutput = output
    command.standardError = FileHandle.nullDevice
    command.standardInput = FileHandle.nullDevice
    do {
      try command.run()
      command.waitUntilExit()
    } catch {
      return nil
    }
    guard command.terminationStatus == 0 else { return nil }
    return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
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
      // Keep waiting rather than converting an ordinary update race into a
      // fatal technical alert. The menu item provides an explicit restart for
      // the rare case where the previous session never returns.
      handoffAttempts = 0
      showUpdateStatus("Soty is waiting for a previous session to close…", canRestartNow: true)
    }
  }

  private func startAgentWhenPortIsFree() {
    probeHealth(timeout: 0.35) { [weak self] health in
      guard let self, !self.isTerminating else { return }
      if let health {
        if self.matchesExpectedBuild(health), health.ready {
          // An exact-build orphan is still safe to use. Do not spawn a
          // duplicate just because its old menu-bar host vanished.
          NSApp.terminate(nil)
          return
        }
        if !self.matchesExpectedBuild(health) {
          if self.shouldReplaceWithExpectedBuild(health) {
            self.waitForPreviousAgent(health)
          } else {
            NSApp.terminate(nil)
          }
          return
        }
        self.waitForPortToBecomeAvailable()
        return
      }
      if self.portIsOccupied() {
        self.waitForPortToBecomeAvailable()
        return
      }
      self.waitingForPreviousAgent = false
      self.portOwnerStopRequested = false
      self.updateDrainRequestInFlight = false
      self.updateWaitTimer?.invalidate()
      self.updateWaitTimer = nil
      self.clearUpdateStatus()
      self.spawnAgent()
    }
  }

  private func waitForPortToBecomeAvailable() {
    waitingForPreviousAgent = true
    let canRestartNow = agentListenerPID().map { isBundledAgentProcess($0) } ?? false
    showUpdateStatus(
      "Soty is waiting for a previous local session to close…",
      canRestartNow: canRestartNow
    )
    beginPreviousAgentWait()
  }

  private func beginPreviousAgentWait() {
    guard !isTerminating else { return }
    if updateWaitTimer == nil {
      updateWaitTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
        self?.checkPreviousAgentForHandoff()
      }
    }
    checkPreviousAgentForHandoff()
  }

  private func checkPreviousAgentForHandoff() {
    probeHealth(timeout: 0.5) { [weak self] health in
      guard let self, !self.isTerminating else { return }
      if let health {
        if self.matchesExpectedBuild(health), health.ready {
          // The Agent became current while we were waiting; one healthy owner
          // is enough, so this duplicate host can disappear quietly.
          NSApp.terminate(nil)
          return
        }
        if self.shouldReplaceWithExpectedBuild(health) {
          self.waitForPreviousAgent(health)
        } else {
          NSApp.terminate(nil)
        }
        return
      }
      if self.portIsOccupied() {
        self.waitForPortToBecomeAvailable()
        return
      }
      self.updateWaitTimer?.invalidate()
      self.updateWaitTimer = nil
      self.waitingForPreviousAgent = false
      self.portOwnerStopRequested = false
      self.updateDrainRequestInFlight = false
      self.clearUpdateStatus()
      if self.acquireInstanceLock() {
        self.startAgentWhenPortIsFree()
      } else {
        self.beginHandoff()
      }
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
      let health =
        statusOK
        ? data.flatMap { try? JSONDecoder().decode(AgentHealth.self, from: $0) }
        : nil
      let recognized = health?.product == "local-video-compressor-agent" ? health : nil
      DispatchQueue.main.async { completion(recognized) }
    }.resume()
  }

  private func matchesExpectedBuild(_ health: AgentHealth) -> Bool {
    health.buildId == expectedBuildID && health.apiVersion == expectedAPIVersion
      && health.sourceRevision == sourceRevision
  }

  private func shouldReplaceWithExpectedBuild(_ health: AgentHealth) -> Bool {
    guard
      let currentBuildID = health.buildId,
      let comparison = compareBuildIDs(expectedBuildID, currentBuildID)
    else {
      // A pre-handoff legacy Agent does not expose a parseable build identity;
      // treat it as older, while still requiring its idle health before the
      // verified fallback ever stops it.
      return true
    }
    return comparison == .orderedDescending
  }

  private func compareBuildIDs(_ left: String, _ right: String) -> ComparisonResult? {
    func identity(_ buildID: String) -> (version: [Int], prerelease: String?, build: [Int])? {
      let parts = buildID.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
      guard parts.count == 2 else { return nil }
      let versionParts = parts[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
      let version = versionParts[0].split(separator: ".").compactMap { Int($0) }
      let build = parts[1].split(separator: ".").compactMap { Int($0) }
      guard version.count == 3, build.count == parts[1].split(separator: ".").count,
        !build.isEmpty
      else { return nil }
      let prerelease = versionParts.count == 2 ? String(versionParts[1]) : nil
      return (version, prerelease, build)
    }
    func compareNumbers(_ first: [Int], _ second: [Int]) -> ComparisonResult {
      for index in 0..<max(first.count, second.count) {
        let difference = (first.indices.contains(index) ? first[index] : 0)
          - (second.indices.contains(index) ? second[index] : 0)
        if difference < 0 { return .orderedAscending }
        if difference > 0 { return .orderedDescending }
      }
      return .orderedSame
    }
    guard let first = identity(left), let second = identity(right) else { return nil }
    let version = compareNumbers(first.version, second.version)
    if version != .orderedSame { return version }
    if first.prerelease != second.prerelease {
      if first.prerelease == nil { return .orderedDescending }
      if second.prerelease == nil { return .orderedAscending }
      return first.prerelease!.compare(second.prerelease!)
    }
    return compareNumbers(first.build, second.build)
  }

  private func spawnAgent() {
    agentReady = false
    let resources = Bundle.main.resourceURL!
    let executable = resources.appendingPathComponent("runtime/node")
    let ffmpeg = resources.appendingPathComponent("runtime/bin/ffmpeg")
    let ffprobe = resources.appendingPathComponent("runtime/bin/ffprobe")
    let agentDirectory = resources.appendingPathComponent("agent")
    let entry = agentDirectory.appendingPathComponent("dist/index.js")
    guard
      [executable, ffmpeg, ffprobe].allSatisfy({
        FileManager.default.isExecutableFile(atPath: $0.path)
      })
    else {
      showFailure(
        "The bundled media runtime is unavailable.",
        details:
          "Reinstall Soty in Applications. Your local queue and original files are safe."
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
    var packagedEnvironment = [
      "PACKAGED_APP": "1",
      "NO_OPEN": "1",
      // Release channel and application environment are distinct at build time,
      // but every packaged channel must supply its runtime environment explicitly.
      // Without this, a beta bundle falls back to production defaults.
      "SOTY_ENVIRONMENT": releaseChannel == "beta" ? "beta" : (releaseChannel == "development" ? "dev" : "production"),
      "AGENT_PORT": String(agentPort),
      "AGENT_SUPPORT_DIRECTORY_NAME": supportDirectoryName,
      "PUBLIC_SITE_ORIGIN": "__PUBLIC_SITE_ORIGIN__",
      "AGENT_VERSION": expectedVersion,
      "AGENT_BUILD_NUMBER": expectedBuildNumber,
      "AGENT_BUILD_ID": expectedBuildID,
      "AGENT_RELEASE_CHANNEL": releaseChannel,
      "AGENT_SOURCE_REVISION": sourceRevision,
      "AGENT_LAUNCHER_PID": String(ProcessInfo.processInfo.processIdentifier),
      "AGENT_INSTALLED_RELEASE_PATH": resources.appendingPathComponent("release.json").path,
      "AGENT_NATIVE_TOKEN": nativeToken,
      "AGENT_ENTITLEMENT_PUBLIC_KEY": "__AGENT_ENTITLEMENT_PUBLIC_KEY__",
    ]
    if let updateHandoffToken {
      packagedEnvironment["AGENT_UPDATE_HANDOFF_TOKEN"] = updateHandoffToken
    }
    child.environment = ProcessInfo.processInfo.environment.merging(packagedEnvironment) {
      _, packaged in packaged
    }
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      guard let text = String(data: handle.availableData, encoding: .utf8), !text.isEmpty else {
        return
      }
      DispatchQueue.main.async {
        self?.stderrText = String(((self?.stderrText ?? "") + text).suffix(12_000))
      }
    }
    child.terminationHandler = { [weak self] finished in
      DispatchQueue.main.async {
        guard let self, !self.isTerminating else { return }
        self.agentReady = false
        self.stopBusyMonitoring()
        self.readinessTimer?.invalidate()
        self.process = nil
        if finished.terminationStatus == updateHandoffExitStatus {
          // The Agent accepted a coordinated update drain. When this app was
          // updated in place, reopen the new payload; when a newer launcher is
          // already waiting, simply release our lock for it.
          if self.installedReleaseAwaitingActivation() != nil {
            self.restartIntoInstalledBuild()
          } else {
            NSApp.terminate(nil)
          }
          return
        }
        if finished.terminationStatus == 75 && self.runtimeRestartAttempts < 2 {
          self.runtimeRestartAttempts += 1
          self.portWaitAttempts = 0
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
            guard !self.isTerminating else { return }
            self.startAgentWhenPortIsFree()
          }
          return
        }
        if self.portIsOccupied() {
          self.waitForPortToBecomeAvailable()
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
      showFailure(
        "The bundled agent runtime could not be started.", details: error.localizedDescription)
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
      guard let self, !self.isTerminating else { return }
      if let health, self.matchesExpectedBuild(health), health.ready {
        self.readinessTimer?.invalidate()
        self.agentReady = true
        self.beginBusyMonitoring()
        self.flushFinderActions()
        self.scheduleFinderIntegrationOffer()
      } else if let health, !self.matchesExpectedBuild(health) {
        self.readinessTimer?.invalidate()
        if self.shouldReplaceWithExpectedBuild(health) {
          self.waitForPreviousAgent(health)
        } else {
          NSApp.terminate(nil)
        }
      } else if self.readinessAttempts >= 60 {
        self.readinessTimer?.invalidate()
        if self.portIsOccupied() {
          self.waitForPortToBecomeAvailable()
        } else {
          self.showFailure("The local agent did not become ready.", details: self.stderrText)
        }
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
      installedReleaseAwaitingActivation() != nil
    else { return }
    installedUpdatePending = true

    probeHealth(timeout: 1) { [weak self] health in
      guard let self, !self.isTerminating, !self.restartingIntoInstalledBuild else { return }
      if health == nil || health?.busy == false {
        self.restartIntoInstalledBuild()
      } else {
        self.showUpdateStatus(
          "Soty will finish updating after the current task.",
          canRestartNow: true
        )
      }
    }
  }

  private func installedReleaseAwaitingActivation() -> InstalledRelease? {
    guard
      let releaseURL = Bundle.main.resourceURL?.appendingPathComponent("release.json"),
      let data = try? Data(contentsOf: releaseURL),
      let installed = try? JSONDecoder().decode(InstalledRelease.self, from: data),
      installed.buildId != expectedBuildID || installed.sourceRevision != sourceRevision
    else { return nil }
    return installed
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
          self.installedUpdatePending = true
          self.showUpdateStatus(
            "Soty could not finish the update. Try again from the menu.",
            canRestartNow: true
          )
          launcherLogger.error("Could not restart installed update: \(error.localizedDescription, privacy: .public)")
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

  @objc func performFinderAction(
    _ pasteboard: NSPasteboard,
    userData: String?,
    error: AutoreleasingUnsafeMutablePointer<NSString?>
  ) {
    launcherLogger.notice("Received Finder action service request")
    guard
      let raw = pasteboard.string(forType: finderActionPasteboardType),
      let data = raw.data(using: .utf8),
      let payload = try? JSONDecoder().decode(FinderActionPayload.self, from: data),
      payload.kind == "image-conversion",
      ["png", "jpeg", "webp"].contains(payload.format),
      !payload.paths.isEmpty,
      payload.paths.count <= 100,
      payload.paths.allSatisfy({ path in
        path.utf8.count <= 4_096 && path.first == "/" && !path.contains("\0")
      })
    else {
      launcherLogger.error("Rejected invalid Finder action service request")
      error.pointee = "Soty received an invalid Finder conversion request."
      return
    }
    launcherLogger.notice(
      "Accepted Finder action payload: format=\(payload.format, privacy: .public), itemCount=\(payload.paths.count, privacy: .public)"
    )
    clearFinderActionFailure()
    pendingFinderActions.append(payload)
    if agentReady { flushFinderActions() }
  }

  private func flushFinderActions() {
    guard agentReady, !pendingFinderActions.isEmpty else { return }
    let actions = pendingFinderActions
    pendingFinderActions.removeAll()
    for action in actions { sendFinderAction(action) }
  }

  private func sendFinderAction(_ action: FinderActionPayload) {
    var request = URLRequest(
      url: agentBaseURL.appendingPathComponent("native/media-actions/images/convert")
    )
    request.httpMethod = "POST"
    request.timeoutInterval = 5
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(nativeToken, forHTTPHeaderField: "X-Wishly-Native-Token")
    request.httpBody = try? JSONEncoder().encode(action)
    URLSession.shared.dataTask(with: request) { [weak self] data, response, requestError in
      let status = (response as? HTTPURLResponse)?.statusCode
      guard
        requestError == nil,
        status == 202,
        let data,
        let accepted = try? JSONDecoder().decode(FinderActionResponse.self, from: data),
        !accepted.jobs.isEmpty
      else {
        launcherLogger.error(
          "Local media engine rejected Finder action: status=\(status ?? -1, privacy: .public), networkError=\(requestError != nil, privacy: .public)"
        )
        DispatchQueue.main.async {
          self?.showFinderActionFailure(
            "Soty could not hand the conversion request to its local media engine."
          )
        }
        return
      }
      launcherLogger.notice(
        "Local media engine accepted Finder action: jobs=\(accepted.jobs.count, privacy: .public)"
      )
      DispatchQueue.main.async {
        guard let self else { return }
        for job in accepted.jobs {
          if job.status == "failed" {
            self.showFinderActionFailure("Soty could not start one of the selected images.")
          } else if job.status == "queued" || job.status == "processing" {
            if self.pendingFinderJobIDs.isEmpty { self.finderPollAttempts = 0 }
            self.pendingFinderJobIDs.insert(job.id)
          }
        }
        self.scheduleFinderActionsPoll()
      }
    }.resume()
  }

  private func scheduleFinderActionsPoll() {
    guard !finderPollScheduled, !finderPollInFlight, !pendingFinderJobIDs.isEmpty else { return }
    finderPollScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self else { return }
      self.finderPollScheduled = false
      self.pollFinderActions()
    }
  }

  private func pollFinderActions() {
    guard !finderPollInFlight, !pendingFinderJobIDs.isEmpty else { return }
    finderPollAttempts += 1
    guard finderPollAttempts < 600 else {
      pendingFinderJobIDs.removeAll()
      showFinderActionFailure("The Finder conversion did not finish in time.")
      return
    }
    var request = URLRequest(url: agentBaseURL.appendingPathComponent("native/media-actions"))
    request.timeoutInterval = 3
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.setValue(nativeToken, forHTTPHeaderField: "X-Wishly-Native-Token")
    finderPollInFlight = true
    URLSession.shared.dataTask(with: request) { [weak self] data, response, requestError in
      let status = (response as? HTTPURLResponse)?.statusCode
      let result =
        requestError == nil && status == 200
        ? data.flatMap { try? JSONDecoder().decode(FinderActionStateResponse.self, from: $0) }
        : nil
      DispatchQueue.main.async {
        guard let self else { return }
        self.finderPollInFlight = false
        guard !self.pendingFinderJobIDs.isEmpty else { return }
        guard let result else {
          self.scheduleFinderActionsPoll()
          return
        }
        for job in result.jobs where self.pendingFinderJobIDs.contains(job.id) {
          switch job.status {
          case "completed", "skipped":
            self.pendingFinderJobIDs.remove(job.id)
          case "failed":
            self.pendingFinderJobIDs.remove(job.id)
            let details = job.error ?? job.errorCode ?? "Unknown conversion error."
            self.showFinderActionFailure(details)
          default:
            break
          }
        }
        self.scheduleFinderActionsPoll()
      }
    }.resume()
  }

  /// Menu-bar feedback for "a tool is running". `/health` already collapses
  /// every module into one busy flag, so poll it and animate the cell while it
  /// is true instead of teaching the launcher about individual tools.
  private func beginBusyMonitoring() {
    guard busyPollTimer == nil else { return }
    scheduleBusyPoll()
    checkBusyState()
  }

  /// Polls quickly while a tool is working, slowly while nothing is.
  ///
  /// The equalizer has to stop within a beat of the work stopping, so the busy
  /// cadence is tight.  Idle is the overwhelmingly common case and every poll
  /// costs the agent a health snapshot, so paying that once a second forever —
  /// to learn a boolean that has not changed since launch — is waste the user
  /// pays for in battery.
  private func scheduleBusyPoll() {
    busyPollTimer?.invalidate()
    let timer = Timer(timeInterval: agentBusy ? 1 : 3, repeats: true) { [weak self] _ in
      self?.checkBusyState()
    }
    // .common keeps the poll and the animation running while a menu is open.
    RunLoop.main.add(timer, forMode: .common)
    busyPollTimer = timer
  }

  private func stopBusyMonitoring() {
    busyPollTimer?.invalidate()
    busyPollTimer = nil
    setAgentBusy(false)
  }

  private func checkBusyState() {
    guard !isTerminating, agentReady, !busyPollInFlight else { return }
    busyPollInFlight = true
    probeHealth(timeout: 0.75) { [weak self] health in
      guard let self else { return }
      self.busyPollInFlight = false
      guard !self.isTerminating, self.agentReady else { return }
      self.setAgentBusy(health?.busy == true)
    }
  }

  private func setAgentBusy(_ busy: Bool) {
    guard busy != agentBusy else { return }
    agentBusy = busy
    // The poll rate follows the state it is polling for.
    if busyPollTimer != nil { scheduleBusyPoll() }
    equalizerTimer?.invalidate()
    equalizerTimer = nil
    if busy {
      equalizerPhase = 0
      let timer = Timer(timeInterval: 1.0 / 12.0, repeats: true) { [weak self] _ in
        self?.advanceEqualizer()
      }
      RunLoop.main.add(timer, forMode: .common)
      equalizerTimer = timer
    }
    refreshStatusIcon()
  }

  private func advanceEqualizer() {
    equalizerPhase += 1
    refreshStatusIcon()
  }

  /// Each bar rides two sines of different periods so the group reads as an
  /// equalizer rather than one marching wave, and never loops visibly.
  private func equalizerLevels() -> [CGFloat] {
    let bars: [(speed: Double, offset: Double)] = [
      (0.62, 0), (0.83, 1.9), (0.47, 3.4), (0.71, 5.1),
    ]
    return bars.map { bar in
      let slow = sin(equalizerPhase * bar.speed + bar.offset)
      let fast = sin(equalizerPhase * bar.speed * 1.7 + bar.offset * 2)
      return CGFloat((slow * 0.65 + fast * 0.35 + 1) / 2)
    }
  }

  /// A Finder failure owns the icon until the user dismisses it, so never let
  /// the animation paint over that warning.
  private func refreshStatusIcon() {
    guard lastFinderFailure == nil else { return }
    statusItem?.button?.image = honeycombStatusImage(
      accessibilityDescription: agentBusy ? "\(applicationName) — working" : applicationName,
      levels: agentBusy ? equalizerLevels() : nil
    )
  }

  private func clearFinderActionFailure() {
    lastFinderFailure = nil
    refreshStatusIcon()
    finderStatusItem?.isHidden = true
  }

  private func showFinderActionFailure(_ details: String) {
    lastFinderFailure = details
    statusItem?.button?.image = NSImage(
      systemSymbolName: "exclamationmark.triangle",
      accessibilityDescription: "Finder action failed"
    )
    finderStatusItem?.title = "Finder conversion failed — Details…"
    finderStatusItem?.isHidden = false
    NSApp.requestUserAttention(.informationalRequest)
  }

  @objc private func showFinderFailureDetails() {
    guard let lastFinderFailure else { return }
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Finder conversion failed"
    alert.informativeText = lastFinderFailure
    alert.addButton(withTitle: "OK")
    alert.runModal()
    clearFinderActionFailure()
  }

  private func updateFinderIntegrationItem() {
    finderIntegrationItem?.title =
      FIFinderSyncController.isExtensionEnabled
      ? "Finder Conversion Settings…"
      : "Enable Finder Conversion…"
  }

  @objc private func manageFinderIntegration() {
    FIFinderSyncController.showExtensionManagementInterface()
  }

  private func scheduleFinderIntegrationOffer() {
    guard
      ProcessInfo.processInfo.environment["NO_OPEN"] != "1",
      !FIFinderSyncController.isExtensionEnabled,
      !UserDefaults.standard.bool(forKey: finderIntegrationOfferKey)
    else { return }
    UserDefaults.standard.set(true, forKey: finderIntegrationOfferKey)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard
        let self,
        !self.isTerminating,
        !FIFinderSyncController.isExtensionEnabled
      else { return }
      NSApp.activate(ignoringOtherApps: true)
      let alert = NSAlert()
      alert.alertStyle = .informational
      alert.messageText = "Enable image conversion in Finder?"
      alert.informativeText = """
        Soty can add Convert to → PNG, JPEG, and WebP to the Finder context menu.

        macOS requires you to enable the Soty Finder extension once in System Settings.
        """
      alert.addButton(withTitle: "Open Settings")
      alert.addButton(withTitle: "Later")
      if alert.runModal() == .alertFirstButtonReturn {
        self.manageFinderIntegration()
      }
    }
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
