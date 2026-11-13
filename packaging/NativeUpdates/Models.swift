import Foundation
import CryptoKit

enum NativeUpdateFailure: String, Error {
  case invalid = "APP_UPDATE_INVALID"
  case stale = "APP_UPDATE_STALE_REVISION"
  case busy = "APP_UPDATE_BUSY"
  case wrongState = "APP_UPDATE_WRONG_STATE"
  case manifest = "APP_UPDATE_MANIFEST_INVALID"
  case changed = "APP_UPDATE_CANDIDATE_CHANGED"
  case target = "APP_UPDATE_WRONG_TARGET"
  case unsafe = "APP_UPDATE_UNSAFE_INSTALLATION"
  case flush = "APP_UPDATE_FLUSH_FAILED"
  case interrupted = "APP_UPDATE_INTERRUPTED"
  case unknown = "APP_UPDATE_REPLACEMENT_UNKNOWN"
  case install = "APP_UPDATE_INSTALL_FAILED"
  case readiness = "APP_UPDATE_READINESS_TIMEOUT"
  case identity = "APP_UPDATE_IDENTITY_MISMATCH"
  case power = "APP_UPDATE_POWER_UNAVAILABLE"
}
struct NativeArchive: Codable, Equatable {
  let url: String
  let sha256: String
  let length: Int64
  let edSignature: String
}
struct NativeCandidate: Codable, Equatable {
  let schemaVersion: Int
  let channel: String
  let target: String
  let version: String
  let buildNumber: String
  let buildId: String
  let sourceRevision: String
  let minimumSystemVersion: String
  let publisherTeamId: String
  let archive: NativeArchive
  var id: String { "\(target):\(archive.sha256)" }
  func validate(channel expectedChannel: String, target expectedTarget: String, fixtureOrigin: String?) throws {
    guard schemaVersion == 1, channel == expectedChannel, target == expectedTarget,
      version.count <= 64, version.range(of: #"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$"#, options: .regularExpression) != nil,
      buildNumber.range(of: #"^\d{1,12}$"#, options: .regularExpression) != nil,
      buildId == "\(version)+\(buildNumber)",
      sourceRevision.range(of: #"^[a-f0-9]{40}$"#, options: .regularExpression) != nil,
      publisherTeamId.range(of: #"^[A-Z0-9]{10}$"#, options: .regularExpression) != nil,
      archive.sha256.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
      minimumSystemVersion.range(of: #"^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$"#, options: .regularExpression) != nil,
      archive.length > 0, archive.length <= NativeUpdateBuildPolicy.archiveBytes,
      Data(base64Encoded: archive.edSignature)?.count == 64,
      let url = URL(string: archive.url), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
    else { throw NativeUpdateFailure.invalid }
    let arch = target == "macos-arm64" ? "arm64" : "x64"
    let suffix = "/v\(version)/Soty-v\(version)-macOS-\(arch).zip"
    if channel == "beta", let origin = fixtureOrigin {
      guard archive.url == origin + suffix else { throw NativeUpdateFailure.manifest }
    } else {
      guard archive.url == NativeUpdateBuildPolicy.artifactPrefix + suffix else { throw NativeUpdateFailure.manifest }
    }
    let os = ProcessInfo.processInfo.operatingSystemVersion
    let installed = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
    guard installed.compare(minimumSystemVersion, options: .numeric) != .orderedAscending else { throw NativeUpdateFailure.target }
  }
}
struct NativeUpdateState: Codable {
  var schemaVersion = 1
  var installationId = UUID().uuidString.lowercased()
  var revision = 0
  var operationId: String?
  var attemptId: String?
  var candidateId: String?
  var candidate: NativeCandidate?
  var stage = "idle"
  var lastProvenStage = "idle"
  var code: String?
  var downloadedBytes: Int64 = 0
  var totalBytes: Int64?
  var nativeSuccess = false
  var uiSuccess = false
  var availableActions = ["check"]
  var automaticDownload = true
  // Private native-only persistence. Projection below excludes these fields.
  var manifestPayload: String?
  var manifestSignature: String?
  var acceptedKeys: [String] = []
  var acceptedAt: Double?
  var sourceBuild: String?
  var sourceRevision: String?
  var epoch: String?
  var sourceBoot: String?
  var targetStarted = false
  var installerReady = false
  var handoffStarted = false
  var preparationDeadline: Double?
  var replacementRequested = false
  var readinessDeadline: Double?
  var receiptSequence = 0
  var recordedAtMs: Double = 0
  func projection() throws -> [String: Any] {
    let data = try JSONEncoder().encode(self)
    guard var value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeUpdateFailure.invalid }
    for key in ["manifestPayload", "manifestSignature", "acceptedKeys", "acceptedAt", "sourceBuild", "sourceRevision", "epoch", "sourceBoot", "targetStarted", "installerReady", "handoffStarted", "readinessDeadline", "preparationDeadline", "replacementRequested", "receiptSequence", "recordedAtMs"] { value.removeValue(forKey: key) }
    // Codable omits nil, whereas the shared API deliberately uses explicit nulls.
    for key in ["operationId", "attemptId", "candidateId", "candidate", "code", "totalBytes"] where value[key] == nil { value[key] = NSNull() }
    return value
  }
}

func nativeManifestCandidate(payload: String, signature: String, publicKey: String, channel: String, target: String, fixtureOrigin: String?) throws -> NativeCandidate {
  guard let bytes = Data(base64Encoded: payload), bytes.count <= NativeUpdateBuildPolicy.canonicalPayloadBytes,
    let keyBytes = Data(base64Encoded: publicKey),
    let signatureBytes = Data(base64Encoded: signature.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/").padding(toLength: ((signature.count + 3) / 4) * 4, withPad: "=", startingAt: 0))
  else { throw NativeUpdateFailure.manifest }
  let key = try P256.Signing.PublicKey(derRepresentation: keyBytes)
  let sig = try P256.Signing.ECDSASignature(rawRepresentation: signatureBytes)
  guard key.isValidSignature(sig, for: bytes),
    let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
    root["schemaVersion"] as? Int == 1, root["channel"] as? String == channel,
    let entries = root["nativeUpdates"] as? [String: Any], let entry = entries[target]
  else { throw NativeUpdateFailure.manifest }
  let candidate = try JSONDecoder().decode(NativeCandidate.self, from: JSONSerialization.data(withJSONObject: entry))
  guard candidate.version == root["version"] as? String, candidate.buildNumber == root["buildNumber"] as? String,
    candidate.buildId == root["buildId"] as? String else { throw NativeUpdateFailure.manifest }
  try candidate.validate(channel: channel, target: target, fixtureOrigin: fixtureOrigin)
  return candidate
}
