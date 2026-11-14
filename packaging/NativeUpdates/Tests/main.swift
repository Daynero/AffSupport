import Foundation
import Darwin
// Isolated native boundary checks; invoked by the probe, never by a production host.
var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  checks += 1
  if !condition() { throw NSError(domain: "SotyNativeUpdateProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
let root = FileManager.default.temporaryDirectory.appendingPathComponent("soty-native-probe-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: root) }
do {
  let fixtureBundleId = NativeUpdateBuildPolicy.fixtureBundleId!
  let fixtureSupport = NativeUpdateBuildPolicy.fixtureSupportDirectory!
  let profileID = "10000000-0000-4000-8000-000000000001"
  let profileInfo: [String: Any] = ["SotyUpdateFixtureProfile": profileID,
    "SotyUpdateFixtureOrigin": "http://127.0.0.1:43141", "SotyNativeUpdatesEnabled": true,
    "CFBundleIdentifier": fixtureBundleId]
  let expectedProfile = "\(fixtureSupport) Updates \(profileID)"
  for _ in 1...3 {
    let name = try NativeUpdateFixtureProfile.supportDirectoryName(base: fixtureSupport, channel: "beta", info: profileInfo)
    try check(name == expectedProfile, "sealed A/B/C profile survives a new host without environment")
  }
  for (base, channel) in [("Soty", "stable"), (fixtureSupport, "beta"), ("Soty Dev", "development")] {
    let name = try NativeUpdateFixtureProfile.supportDirectoryName(base: base, channel: channel, info: [:])
    try check(name == base, "ordinary profile unchanged")
  }
  for mutation in ["missing", "path", "production", "disabled", "remote", "bundle"] {
    var info = profileInfo
    var channel = "beta"
    if mutation == "missing" { info.removeValue(forKey: "SotyUpdateFixtureProfile") }
    if mutation == "path" { info["SotyUpdateFixtureProfile"] = "../Soty" }
    if mutation == "production" { channel = "stable" }
    if mutation == "disabled" { info["SotyNativeUpdatesEnabled"] = false }
    if mutation == "remote" { info["SotyUpdateFixtureOrigin"] = "https://example.com" }
    if mutation == "bundle" { info["CFBundleIdentifier"] = "com.wishly" }
    var refused = false
    do { _ = try NativeUpdateFixtureProfile.supportDirectoryName(base: fixtureSupport, channel: channel, info: info) }
    catch { refused = true }
    try check(refused, "invalid fixture cannot fall back to normal beta")
  }
  let profiles = root.appendingPathComponent("profiles")
  try NativeUpdateFixtureProfile.prepareDirectory(root: profiles, name: expectedProfile)
  let alias = profiles.appendingPathComponent("\(fixtureSupport) Updates alias")
  try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: profiles.appendingPathComponent(expectedProfile))
  var unsafeProfile = false
  do { try NativeUpdateFixtureProfile.prepareDirectory(root: profiles, name: alias.lastPathComponent) }
  catch { unsafeProfile = true }
  try check(unsafeProfile, "fixture directory cannot alias owner data")
  let store = try NativeUpdateReceiptStore(directory: root)
  var state = try store.load()
  let identity = state.installationId
  try check(UUID(uuidString: identity) != nil, "installation identity")
  for sequence in 1...40 { state.revision = sequence; state.receiptSequence = sequence; try store.save(state) }
  let restored = try store.load()
  try check(restored.revision == 40 && restored.installationId == identity, "durable native state")
  let history = try store.history()
  try check(history.count == 32, "bounded native history")
  var locked = false
  do { _ = try NativeUpdateReceiptStore(directory: root) } catch { locked = true }
  try check(locked, "one native writer")
  try Data("{truncated".utf8).write(to: root.appendingPathComponent("native.json"))
  var refused = false
  do { _ = try store.load() } catch { refused = true }
  try check(refused, "corrupt receipt cannot become idle")
  try store.preserveDamagedReceipt()
  let files = try FileManager.default.contentsOfDirectory(atPath: root.path)
  try check(files.contains(where: { $0.hasPrefix("native-corrupt-") }), "corrupt evidence retained")
  state.stage = "preparing"
  try check(NativeUpdateRecovery.decide(state: state, buildId: "a", revision: "a", committedWorkload: false) == .prepareAgain, "preconsent restart")
  state.candidate = NativeCandidate(schemaVersion: 1, channel: "stable", target: "macos-arm64", version: "9.0.0", buildNumber: "999", buildId: "9.0.0+999", sourceRevision: String(repeating: "b", count: 40), minimumSystemVersion: "13.0", publisherTeamId: "TESTTEAM12", archive: NativeArchive(url: "https://invalid.test", sha256: String(repeating: "a", count: 64), length: 5, edSignature: "test"))
  state.acceptedAt = 1; state.sourceBuild = "8.0.0+998"; state.sourceRevision = String(repeating: "a", count: 40); state.stage = "drained"
  try check(NativeUpdateRecovery.decide(state: state, buildId: state.sourceBuild!, revision: state.sourceRevision!, committedWorkload: false) == .deferUnstarted, "precommit source restart is reversible")
  state.targetStarted = true
  try check(NativeUpdateRecovery.decide(state: state, buildId: state.sourceBuild!, revision: state.sourceRevision!, committedWorkload: true) == .unknown, "never automatically downgrade after target start")
  try check(NativeUpdateRecovery.decide(state: state, buildId: "9.0.0+999", revision: String(repeating: "b", count: 40), committedWorkload: false) == .unknown, "new version without matching work receipt is not success")
  try check(NativeUpdateRecovery.decide(state: state, buildId: "9.0.0+999", revision: String(repeating: "b", count: 40), committedWorkload: true) == .startTarget, "exact committed target can report readiness")
  let wrongPid: [String: Any] = ["pid": 99, "buildId": "9.0.0+999", "sourceRevision": String(repeating: "b", count: 40), "attemptId": "a", "installationId": identity]
  try check(!NativeUpdateReadiness.matches(candidate: state.candidate!, installedBuild: "9.0.0+999", installedRevision: String(repeating: "b", count: 40), payload: wrongPid, agentPid: 100, attempt: "a", installation: identity), "another runtime cannot claim readiness")
  state.nativeSuccess = true
  try check(NativeUpdateRecovery.decide(state: state, buildId: "8.0.0+998", revision: String(repeating: "a", count: 40), committedWorkload: true) == .unknown, "completed receipt cannot authorize an older app copy")
  print("{\"ok\":true,\"checks\":\(checks),\"scope\":\"native-store-and-recovery\"}")
} catch {
  fputs("Native updater boundary probe failed.\n", stderr)
  exit(1)
}
