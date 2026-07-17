import AppKit
import Darwin
import Foundation

private let agentBaseURL = URL(string: "http://127.0.0.1:43120")!

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var process: Process?
  private var stderrText = ""
  private var readinessTimer: Timer?
  private var readinessAttempts = 0
  private var openedPairing = false
  private var statusItem: NSStatusItem?
  private var lockFD: Int32 = -1
  private var isTerminating = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    installMenuBarItem()
    guard acquireInstanceLock() else { openPairingWhenReadyOrQuit(); return }
    startAgent()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    isTerminating = true
    readinessTimer?.invalidate()
    if let process, process.isRunning { process.terminate(); process.waitUntilExit() }
    return .terminateNow
  }

  private func acquireInstanceLock() -> Bool {
    let lockURL = FileManager.default.temporaryDirectory.appendingPathComponent("local-video-compressor-agent.lock")
    lockFD = Darwin.open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    return lockFD >= 0 && flock(lockFD, LOCK_EX | LOCK_NB) == 0
  }

  private func installMenuBarItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = NSImage(systemSymbolName: "film.stack", accessibilityDescription: "Local Video Compressor Agent")
    let menu = NSMenu()
    let openItem = menu.addItem(withTitle: "Open Local Video Compressor", action: #selector(openPairing), keyEquivalent: "o")
    openItem.target = self
    menu.addItem(.separator())
    let quitItem = menu.addItem(withTitle: "Quit Local Video Compressor Agent", action: #selector(quit), keyEquivalent: "q")
    quitItem.target = self
    item.menu = menu
    statusItem = item
  }

  private func startAgent() {
    // A healthy agent may already be listening — e.g. one orphaned by a crashed launcher
    // that has not yet exited, or a developer instance. Adopt it instead of spawning a
    // duplicate that would fail to bind port 43120 and surface a scary error.
    probeReady(timeout: 1) { [weak self] ready in
      guard let self, !self.openedPairing else { return }
      if ready { self.openedPairing = true; self.openPairing() }
      else { self.spawnAgent() }
    }
  }

  private func probeReady(timeout: TimeInterval, completion: @escaping (Bool) -> Void) {
    var request = URLRequest(url: agentBaseURL.appendingPathComponent("health"))
    request.timeoutInterval = timeout
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let ready = (response as? HTTPURLResponse)?.statusCode == 200 && data.flatMap { String(data: $0, encoding: .utf8) }?.contains("\"product\":\"local-video-compressor-agent\"") == true
      DispatchQueue.main.async { completion(ready) }
    }.resume()
  }

  private func spawnAgent() {
    let resources = Bundle.main.resourceURL!
    let executable = resources.appendingPathComponent("runtime/node")
    let agentDirectory = resources.appendingPathComponent("agent")
    let entry = agentDirectory.appendingPathComponent("dist/index.js")
    let child = Process()
    let output = Pipe()
    child.executableURL = executable
    child.arguments = [entry.path]
    child.currentDirectoryURL = agentDirectory
    child.standardOutput = output
    child.standardError = output
    child.environment = ProcessInfo.processInfo.environment.merging([
      "PACKAGED_APP": "1", "NO_OPEN": "1", "PUBLIC_SITE_ORIGIN": "__PUBLIC_SITE_ORIGIN__"
    ]) { _, packaged in packaged }
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      guard let text = String(data: handle.availableData, encoding: .utf8), !text.isEmpty else { return }
      DispatchQueue.main.async { self?.stderrText = String(((self?.stderrText ?? "") + text).suffix(12_000)) }
    }
    child.terminationHandler = { [weak self] finished in
      DispatchQueue.main.async {
        guard let self, !self.isTerminating else { return }
        self.readinessTimer?.invalidate()
        self.showFailure("The local agent exited with status \(finished.terminationStatus).", details: self.stderrText)
      }
    }
    do { try child.run(); process = child; beginReadinessChecks() }
    catch { showFailure("The bundled agent runtime could not be started.", details: error.localizedDescription) }
  }

  private func beginReadinessChecks() {
    readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.checkReadiness() }
    checkReadiness()
  }

  private func checkReadiness() {
    readinessAttempts += 1
    var request = URLRequest(url: agentBaseURL.appendingPathComponent("health"))
    request.timeoutInterval = 1
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      guard let self else { return }
      let ready = (response as? HTTPURLResponse)?.statusCode == 200 && data.flatMap { String(data: $0, encoding: .utf8) }?.contains("\"product\":\"local-video-compressor-agent\"") == true
      DispatchQueue.main.async {
        guard !self.openedPairing else { return }
        if ready {
          self.readinessTimer?.invalidate()
          self.openedPairing = true
          if ProcessInfo.processInfo.environment["NO_OPEN"] != "1" { self.openPairing() }
        }
        else if self.readinessAttempts >= 60 { self.readinessTimer?.invalidate(); self.showFailure("The local agent did not become ready.", details: self.stderrText) }
      }
    }.resume()
  }

  private func openPairingWhenReadyOrQuit() {
    var request = URLRequest(url: agentBaseURL.appendingPathComponent("health"))
    request.timeoutInterval = 2
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let ready = (response as? HTTPURLResponse)?.statusCode == 200 && data.flatMap { String(data: $0, encoding: .utf8) }?.contains("\"product\":\"local-video-compressor-agent\"") == true
      DispatchQueue.main.async {
        if ready { self?.openPairing() }
        else { self?.showFailure("Another copy is starting, but it is not ready yet.", details: "Wait a moment and choose Open Local Video Compressor from the menu bar agent.") }
        NSApp.terminate(nil)
      }
    }.resume()
  }

  // Open the UI served by the agent itself (same http origin as the API) rather than the
  // hosted HTTPS site. A cross-origin HTTPS page reaching http://127.0.0.1 is blocked outright
  // by Safari (mixed content) and is fragile in Chrome (private-network access), so the packaged
  // app always uses the loopback origin, where fetches to the API are plain same-origin requests.
  @objc private func openPairing() { NSWorkspace.shared.open(agentBaseURL.appendingPathComponent("local")) }
  @objc private func quit() { NSApp.terminate(nil) }

  private func showFailure(_ message: String, details: String) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "Local Video Compressor Agent could not start"
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
