import Foundation
import AppKit
import Security
import CryptoKit

final class NativeAppUpdateCoordinator {
  let directory: URL
  let socketPath: String
  let token = [UUID(), UUID()].map { $0.uuidString }.joined()
  private let store: NativeUpdateReceiptStore
  private var state: NativeUpdateState
  private var durableState: NativeUpdateState?
  private var bridge: NativeUpdateSocket?
  private var driver: SotySparkleDriver?
  private let publicKey: String
  private let channel: String
  private let target: String
  private let buildId: String
  private let revision: String
  private let version: String
  private let feedURL: URL
  private let fixtureOrigin: String?
  private let publisher: String
  private var manifestEnvelope: (String, String)?
  private var readinessTimer: Timer?
  private var sleepStarted: Double?
  private var sleepObservers: [NSObjectProtocol] = []
  private var checkRequested = false
  func requestCheck() { checkRequested = true }
  var agentPid: Int32 = 0
  var onChange: (() -> Void)?
  var awaitingAgentExit: Bool { state.installerReady && state.stage == "install_committed" }
  var permitsQuit: Bool { driver == nil || ["replacement_started", "relaunch_requested", "recovering", "unknown"].contains(state.stage) }

  init(support: URL, channel: String, target: String, version: String, buildId: String, revision: String, agentURL: URL) throws {
    guard Bundle.main.object(forInfoDictionaryKey: "SotyNativeUpdatesEnabled") as? Bool == true,
      let publicKey = Bundle.main.object(forInfoDictionaryKey: "SotyUpdateManifestPublicKey") as? String,
      Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String != nil,
      channel == "stable" || channel == "beta"
    else { throw NativeUpdateFailure.unsafe }
    self.publicKey = publicKey; self.channel = channel; self.target = target
    self.version = version; self.buildId = buildId; self.revision = revision
    self.feedURL = agentURL.appendingPathComponent(".well-known/soty/app-update.xml")
    fixtureOrigin = channel == "beta" ? Bundle.main.object(forInfoDictionaryKey: "SotyUpdateFixtureOrigin") as? String : nil
    directory = support.appendingPathComponent("Updates/\(channel)", isDirectory: true)
    let socketID = SHA256.hash(data: Data(directory.path.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
    let socketDirectory = URL(fileURLWithPath: "/tmp", isDirectory: true).appendingPathComponent("soty-update-\(getuid())-\(socketID)", isDirectory: true)
    try FileManager.default.createDirectory(at: socketDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var socketInfo = stat()
    guard lstat(socketDirectory.path, &socketInfo) == 0, socketInfo.st_mode & S_IFMT == S_IFDIR,
      socketInfo.st_uid == getuid(), socketInfo.st_mode & 0o077 == 0 else { throw NativeUpdateFailure.unsafe }
    socketPath = socketDirectory.appendingPathComponent("host.sock").path
    store = try NativeUpdateReceiptStore(directory: directory)
    publisher = try Self.signingTeam()
    do {
      state = try store.load()
      if let candidate = state.candidate {
        guard let payload = state.manifestPayload, let signature = state.manifestSignature,
          try nativeManifestCandidate(payload: payload, signature: signature, publicKey: publicKey, channel: channel, target: target, fixtureOrigin: fixtureOrigin) == candidate else { throw NativeUpdateFailure.unknown }
        manifestEnvelope = (payload, signature)
      }
      durableState = state
    }
    catch {
      // Preserve the damaged file for diagnosis, never erase an uncertain install.
      try store.preserveDamagedReceipt()
      state = NativeUpdateState(); state.installationId = store.installationId
      state.attemptId = UUID().uuidString.lowercased()
      state.stage = "unknown"; state.code = NativeUpdateFailure.unknown.rawValue
    }
    do { try reconcileOnStartup() }
    catch { state.stage = "unknown"; state.code = NativeUpdateFailure.unknown.rawValue }
    try persist()
    bridge = try NativeUpdateSocket(path: socketPath, token: token) { [weak self] request in
      guard let self else { throw NativeUpdateFailure.interrupted }
      return try self.handle(request)
    }
    let notifications = NSWorkspace.shared.notificationCenter
    sleepObservers.append(notifications.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
      self?.sleepStarted = Date().timeIntervalSince1970
    })
    sleepObservers.append(notifications.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, let began = self.sleepStarted else { return }
      let duration = max(0, Date().timeIntervalSince1970 - began)
      if let deadline = self.state.readinessDeadline { self.state.readinessDeadline = deadline + duration }
      if let deadline = self.state.preparationDeadline { self.state.preparationDeadline = deadline + duration }
      self.sleepStarted = nil; try? self.persist()
    })
    readinessTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.checkDeadlines() }
  }
  deinit {
    readinessTimer?.invalidate()
    for observer in sleepObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
  }
  private func checkDeadlines() {
    guard sleepStarted == nil else { return }
    let now = Date().timeIntervalSince1970
    if let deadline = state.readinessDeadline, !state.nativeSuccess, now > deadline {
      state.readinessDeadline = nil
      try? change("recovering", code: NativeUpdateFailure.readiness.rawValue)
    }
    if let deadline = state.preparationDeadline, state.stage == "install_committed", now > deadline {
      state.preparationDeadline = nil
      try? change("recovering", code: "APP_UPDATE_DOWNLOAD_TIMEOUT")
      _ = driver?.cancelDownload() // Supported download cancellation only; no extraction kill.
    }
  }

  func menuTitle() -> String {
    switch state.stage {
    case "offered", "prepared", "deferred": return "Update Soty…"
    case "consented", "draining", "drained": return "Waiting for current tasks…"
    case "install_committed", "replacement_started", "relaunch_requested": return "Updating Soty…"
    case "unknown", "recovering", "failed": return "Soty update needs attention…"
    default: return "Check for Soty updates…"
    }
  }
  func agentDidExit(_ exitCode: Int32) {
    if awaitingAgentExit && exitCode == 76 {
      do { state.replacementRequested = true; try change("replacement_started"); driver?.installAfterAgentExit() }
      catch { state.stage = "recovering"; state.code = NativeUpdateFailure.flush.rawValue }
    }
    else if state.stage == "install_committed" { try? change("recovering", code: NativeUpdateFailure.interrupted.rawValue) }
  }
  private func handle(_ request: [String: Any]) throws -> [String: Any] {
    guard let action = request["action"] as? String, let payload = request["payload"] as? [String: Any] else { throw NativeUpdateFailure.invalid }
    switch action {
    case "snapshot": return try state.projection()
    case "receipts": return ["records": try store.history()]
    case "hello":
      guard payload["pid"] as? Int32 == agentPid || payload["pid"] as? Int == Int(agentPid), agentPid > 0 else { throw NativeUpdateFailure.identity }
      return ["state": try state.projection(), "manifestURL": manifestURL(), "publicKey": publicKey, "channel": channel, "target": target]
    case "offer":
      guard let encoded = payload["payload"] as? String, let signature = payload["signature"] as? String else { throw NativeUpdateFailure.manifest }
      let candidate = try nativeManifestCandidate(payload: encoded, signature: signature, publicKey: publicKey, channel: channel, target: target, fixtureOrigin: fixtureOrigin)
      guard candidate.publisherTeamId == publisher else { throw NativeUpdateFailure.identity }
      if let active = state.candidate, !["idle", "offered", "prepared", "deferred", "failed", "cancelled", "ui_visible", "native_ready"].contains(state.stage), candidate != active { throw NativeUpdateFailure.changed }
      guard Self.compare(candidate.version, version) > 0 || (candidate.version == version && (Int64(candidate.buildNumber) ?? 0) > (Int64(buildId.split(separator: "+").last ?? "0") ?? 0)) else { throw NativeUpdateFailure.changed }
      manifestEnvelope = (encoded, signature)
      state.manifestPayload = encoded; state.manifestSignature = signature
      if state.candidate != candidate || state.stage == "cancelled" {
        state.candidate = candidate; state.candidateId = candidate.id; state.downloadedBytes = 0
        state.totalBytes = candidate.archive.length; state.nativeSuccess = false; state.uiSuccess = false
        state.operationId = UUID().uuidString.lowercased(); state.attemptId = nil; state.acceptedAt = nil
        state.handoffStarted = false; state.replacementRequested = false; state.targetStarted = false; state.epoch = nil
        try change("offered")
      }
    case "command": try command(payload)
    case "progress":
      guard state.stage == "preparing", let bytes = payload["bytes"] as? Int64, bytes >= 0, bytes <= (state.totalBytes ?? 0) else { throw NativeUpdateFailure.wrongState }
      state.downloadedBytes = bytes
    case "prepared":
      guard state.stage == "preparing", payload["candidateId"] as? String == state.candidateId else { throw NativeUpdateFailure.changed }
      state.downloadedBytes = state.totalBytes ?? 0; try change("prepared")
    case "draining":
      guard state.stage == "consented" else { throw NativeUpdateFailure.wrongState }
      try change("draining")
    case "drained":
      guard state.stage == "consented" || state.stage == "draining", let epoch = payload["epoch"] as? String else { throw NativeUpdateFailure.wrongState }
      let receipt = try store.workload()
      guard receipt["attemptId"] as? String == state.attemptId, receipt["candidateId"] as? String == state.candidateId,
        receipt["installationId"] as? String == state.installationId, receipt["epoch"] as? String == epoch,
        receipt["stage"] as? String == "drained", receipt["bootId"] as? String == state.sourceBoot else { throw NativeUpdateFailure.flush }
      state.epoch = epoch; try change("drained")
    case "install":
      guard state.stage == "drained", let candidate = state.candidate, let envelope = manifestEnvelope,
        payload["attemptId"] as? String == state.attemptId else { throw NativeUpdateFailure.wrongState }
      // Fresh verification is supplied by the agent's fixed-origin check before this call.
      let fresh = try nativeManifestCandidate(payload: envelope.0, signature: envelope.1, publicKey: publicKey, channel: channel, target: target, fixtureOrigin: fixtureOrigin)
      guard fresh == candidate else { throw NativeUpdateFailure.changed }
      let receipt = try store.workload()
      guard receipt["stage"] as? String == "committed", receipt["epoch"] as? String == state.epoch,
        receipt["attemptId"] as? String == state.attemptId else { throw NativeUpdateFailure.flush }
      try verifyInstallation()
      guard let budget = payload["preparationBudgetMs"] as? Double, budget >= NativeUpdateBuildPolicy.downloadTimeoutMs, budget <= NativeUpdateBuildPolicy.maximumPreparationTimeoutMs else { throw NativeUpdateFailure.invalid }
      state.preparationDeadline = Date().timeIntervalSince1970 + budget / 1000
      try change("install_committed")
      let data = try JSONEncoder().encode(candidate)
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeUpdateFailure.invalid }
      driver = SotySparkleDriver(candidate: object, feedURL: feedURL) { [weak self] stage, received, total, code in
        guard let self else { return }
        self.state.downloadedBytes = Int64(received); self.state.totalBytes = Int64(total)
        do {
          if stage == "installer_ready" { guard self.state.stage == "install_committed" else { return }; self.state.preparationDeadline = nil; self.state.installerReady = true; try self.persist() }
          else if stage == "extracting" { try self.persist() }
          else if stage == self.state.stage { /* Progress is volatile; stage receipts remain bounded. */ }
          else if stage == "failed" && !self.state.replacementRequested && self.state.handoffStarted {
            // SDK ended before we ever replied Install at the ready boundary.
            // Persist positive no-handoff evidence before releasing agent work.
            self.state.handoffStarted = false; self.state.installerReady = false; self.state.preparationDeadline = nil
            self.state.lastProvenStage = "drained"; self.driver = nil
            try self.change("failed", code: code.isEmpty ? NativeUpdateFailure.install.rawValue : code)
          } else if !["unknown", "recovering"].contains(self.state.stage) || stage == "failed" { try self.change(stage == "failed" ? "recovering" : stage, code: code.isEmpty ? nil : code) }
        } catch { self.state.installerReady = false; self.state.stage = "recovering"; self.state.code = NativeUpdateFailure.flush.rawValue }
      }
      state.handoffStarted = true; try persist()
      do { try driver?.start() }
      catch {
        state.handoffStarted = false; state.lastProvenStage = "drained"
        driver = nil; try change("failed", code: NativeUpdateFailure.install.rawValue)
        throw NativeUpdateFailure.install
      }
    case "pending":
      let requested = checkRequested; checkRequested = false
      return ["installerReady": state.installerReady, "handoffStarted": state.handoffStarted, "checkRequested": requested, "state": try state.projection()]
    case "failed":
      guard let code = payload["code"] as? String, NativeUpdateBuildPolicy.failureCodes.contains(code) else { throw NativeUpdateFailure.invalid }
      let uncertain = state.handoffStarted || state.replacementRequested || ["install_committed", "replacement_started", "relaunch_requested", "recovering", "unknown"].contains(state.stage)
      try change(uncertain ? "recovering" : "failed", code: code)
    case "target-ready":
      guard state.stage == "target_started" || state.stage == "native_ready", let candidate = state.candidate,
        NativeUpdateReadiness.matches(candidate: candidate, installedBuild: buildId, installedRevision: revision,
          payload: payload, agentPid: agentPid, attempt: state.attemptId, installation: state.installationId)
      else { throw NativeUpdateFailure.identity }
      state.nativeSuccess = true; state.readinessDeadline = nil; try change("native_ready")
    default: throw NativeUpdateFailure.invalid
    }
    return try state.projection()
  }
  private func command(_ payload: [String: Any]) throws {
    guard let action = payload["action"] as? String, let body = payload["command"] as? [String: Any],
      body["schemaVersion"] as? Int == 1, let key = body["idempotencyKey"] as? String, UUID(uuidString: key) != nil,
      let expected = body["expectedRevision"] as? Int,
      Set(body.keys).isSubset(of: ["schemaVersion", "idempotencyKey", "expectedRevision", "candidateId", "automaticDownload"])
    else { throw NativeUpdateFailure.invalid }
    if state.acceptedKeys.contains(key) { return }
    guard expected == state.revision else { throw NativeUpdateFailure.stale }
    guard body.keys.contains("candidateId"), body["candidateId"] as? String == state.candidateId else { throw NativeUpdateFailure.changed }
    guard state.availableActions.contains(action) else { throw NativeUpdateFailure.wrongState }
    switch action {
    case "set-auto-download":
      guard let enabled = body["automaticDownload"] as? Bool else { throw NativeUpdateFailure.invalid }
      state.automaticDownload = enabled
    case "prepare":
      guard ["offered", "deferred", "failed", "prepared"].contains(state.stage) else { throw NativeUpdateFailure.wrongState }
      state.attemptId = UUID().uuidString.lowercased(); try change("preparing")
    case "accept":
      guard ["prepared", "deferred"].contains(state.stage), let boot = payload["bootId"] as? String, UUID(uuidString: boot) != nil else { throw NativeUpdateFailure.wrongState }
      if state.operationId == nil { state.operationId = UUID().uuidString.lowercased() }
      if state.attemptId == nil { state.attemptId = UUID().uuidString.lowercased() }
      state.acceptedAt = Date().timeIntervalSince1970; state.sourceBuild = buildId; state.sourceRevision = revision
      state.sourceBoot = boot; state.targetStarted = false; state.installerReady = false; state.handoffStarted = false; state.replacementRequested = false; state.preparationDeadline = nil
      try change("consented")
    case "defer", "cancel":
      guard ["offered", "prepared", "preparing", "consented", "draining", "drained", "deferred", "failed"].contains(state.stage) else { throw NativeUpdateFailure.wrongState }
      state.acceptedAt = nil; state.epoch = nil
      try change(action == "defer" ? "deferred" : "cancelled")
    case "ack-visible": guard state.nativeSuccess else { throw NativeUpdateFailure.wrongState }; state.uiSuccess = true; try change("ui_visible")
    default: throw NativeUpdateFailure.invalid
    }
    state.acceptedKeys.append(key); state.acceptedKeys = Array(state.acceptedKeys.suffix(NativeUpdateBuildPolicy.historyEntries)); try persist()
  }
  private func change(_ stage: String, code: String? = nil) throws {
    let known = ["idle", "offered", "preparing", "prepared", "consented", "draining", "drained", "install_committed", "replacement_started", "replacement_committed", "relaunch_requested", "target_started", "native_ready", "ui_visible", "deferred", "cancelled", "failed", "recovering", "unknown"]
    guard known.contains(stage) else { throw NativeUpdateFailure.invalid }
    state.stage = stage; state.code = code
    if !["failed", "unknown", "recovering"].contains(stage) { state.lastProvenStage = stage }
    try persist()
  }
  private func persist() throws {
    state.revision += 1; state.receiptSequence += 1; state.recordedAtMs = Date().timeIntervalSince1970 * 1000
    switch state.stage {
    case "idle", "cancelled", "ui_visible": state.availableActions = ["check"]
    case "offered", "failed": state.availableActions = ["check", "prepare", "defer", "cancel"]
    case "preparing": state.availableActions = ["cancel", "defer"]
    case "prepared": state.availableActions = ["check", "accept", "defer", "cancel"]
    case "deferred":
      let prepared = state.candidate != nil && state.attemptId != nil && state.downloadedBytes == state.candidate?.archive.length
      state.availableActions = prepared ? ["check", "accept", "defer", "cancel"] : ["check", "prepare", "cancel"]
    case "consented", "draining", "drained": state.availableActions = ["defer"]
    case "native_ready": state.availableActions = ["ack-visible"]
    default: state.availableActions = []
    }
    if !["install_committed", "replacement_started", "relaunch_requested", "target_started", "unknown", "recovering"].contains(state.stage) { state.availableActions.append("set-auto-download") }
    do { try store.save(state); durableState = state; onChange?() }
    catch {
      // Never expose a mutation as durable/native success after a failed write.
      if let confirmed = durableState { state = confirmed }
      state.stage = "recovering"; state.code = NativeUpdateFailure.flush.rawValue
      state.availableActions = []; onChange?()
      throw NativeUpdateFailure.flush
    }
  }
  private func reconcileOnStartup() throws {
    // A completed receipt belongs to that exact host. Opening an older app copy
    // must not revive code after the target has already touched local state.
    if let previous = state.candidate,
      (state.nativeSuccess || (state.stage == "unknown" && state.code == NativeUpdateFailure.identity.rawValue && state.acceptedAt == nil)),
      previous.buildId != buildId || previous.sourceRevision != revision {
      let comparison = Self.compare(version, previous.version)
      let currentBuild = Int64(buildId.split(separator: "+").last ?? "0") ?? 0
      let previousBuild = Int64(previous.buildNumber) ?? 0
      if comparison > 0 || (comparison == 0 && currentBuild > previousBuild) {
        var fresh = NativeUpdateState(); fresh.installationId = state.installationId
        fresh.revision = state.revision; fresh.receiptSequence = state.receiptSequence
        state = fresh; manifestEnvelope = nil
      } else {
        state.operationId = UUID().uuidString.lowercased(); state.attemptId = UUID().uuidString.lowercased()
        state.nativeSuccess = false; state.uiSuccess = false; state.acceptedAt = nil
        state.stage = "unknown"; state.lastProvenStage = "idle"; state.code = NativeUpdateFailure.identity.rawValue
      }
      return
    }
    if state.stage == "unknown", state.code == NativeUpdateFailure.identity.rawValue, state.acceptedAt == nil,
      let candidate = state.candidate, candidate.buildId == buildId, candidate.sourceRevision == revision {
      var fresh = NativeUpdateState(); fresh.installationId = state.installationId
      fresh.revision = state.revision; fresh.receiptSequence = state.receiptSequence
      state = fresh; manifestEnvelope = nil; return
    }
    let receipt = try? store.workload()
    let committed = receipt?["stage"] as? String == "committed" &&
      receipt?["attemptId"] as? String == state.attemptId && receipt?["candidateId"] as? String == state.candidateId &&
      receipt?["installationId"] as? String == state.installationId && receipt?["epoch"] as? String == state.epoch
    switch NativeUpdateRecovery.decide(state: state, buildId: buildId, revision: revision, committedWorkload: committed) {
    case .unchanged: break
    case .prepareAgain: state.stage = "offered"; state.downloadedBytes = 0; state.code = NativeUpdateFailure.interrupted.rawValue
    case .deferUnstarted:
      state.acceptedAt = nil; state.epoch = nil; state.stage = "deferred"; state.code = NativeUpdateFailure.interrupted.rawValue
    case .startTarget:
      state.targetStarted = true; state.lastProvenStage = "replacement_committed"; state.stage = "target_started"
      state.readinessDeadline = Date().timeIntervalSince1970 + NativeUpdateBuildPolicy.readinessSeconds
    case .unknown: state.stage = "unknown"; state.code = NativeUpdateFailure.unknown.rawValue
    }
  }

  private func verifyInstallation() throws {
    let url = Bundle.main.bundleURL.resolvingSymlinksInPath()
    guard url.pathExtension == "app", !url.path.hasPrefix("/Volumes/"), !url.path.contains("/AppTranslocation/") else { throw NativeUpdateFailure.unsafe }
    // Sparkle owns the single system authorization prompt for /Applications.
    // Other locations must be user-writable; never chmod or relocate a bundle.
    guard url.deletingLastPathComponent().path == "/Applications" || FileManager.default.isWritableFile(atPath: url.deletingLastPathComponent().path) else { throw NativeUpdateFailure.unsafe }
    guard try Self.signingTeam() == publisher else { throw NativeUpdateFailure.identity }
    let releaseURL = url.appendingPathComponent("Contents/Resources/release.json")
    let releaseBytes = try Data(contentsOf: releaseURL)
    guard releaseBytes.count <= 16384, let installed = try JSONSerialization.jsonObject(with: releaseBytes) as? [String: Any],
      installed["buildId"] as? String == buildId, installed["sourceRevision"] as? String == revision,
      installed["target"] as? String == target else { throw NativeUpdateFailure.identity }
  }
  private func manifestURL() -> String {
    if channel == "beta", let origin = fixtureOrigin { return origin + "/stable.json" }
    return Bundle.main.object(forInfoDictionaryKey: "SotyUpdateManifestURL") as? String ?? ""
  }
  private static func signingTeam() throws -> String {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &code) == errSecSuccess, let code,
      SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), nil) == errSecSuccess else { throw NativeUpdateFailure.unsafe }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      let details = info as? [String: Any], let team = details[kSecCodeInfoTeamIdentifier as String] as? String else { throw NativeUpdateFailure.identity }
    return team
  }
  private static func compare(_ left: String, _ right: String) -> Int {
    let a = left.split(separator: "-", maxSplits: 1); let b = right.split(separator: "-", maxSplits: 1)
    let x = a[0].split(separator: ".").compactMap { Int($0) }; let y = b[0].split(separator: ".").compactMap { Int($0) }
    guard x.count == 3, y.count == 3 else { return -1 }
    for i in 0..<3 where x[i] != y[i] { return x[i] > y[i] ? 1 : -1 }
    if a.count == 1 && b.count == 1 { return 0 }; if a.count == 1 { return 1 }; if b.count == 1 { return -1 }
    let p = a[1].split(separator: "."); let q = b[1].split(separator: ".")
    for i in 0..<max(p.count, q.count) {
      if i >= p.count { return -1 }; if i >= q.count { return 1 }; if p[i] == q[i] { continue }
      if let m = Int(p[i]), let n = Int(q[i]) { return m > n ? 1 : -1 }
      if Int(p[i]) != nil { return -1 }; if Int(q[i]) != nil { return 1 }
      return p[i] > q[i] ? 1 : -1
    }
    return 0
  }
}
