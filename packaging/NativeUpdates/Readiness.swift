import Foundation
enum NativeUpdateReadiness {
  static func matches(candidate: NativeCandidate, installedBuild: String, installedRevision: String,
    payload: [String: Any], agentPid: Int32, attempt: String?, installation: String) -> Bool {
    return agentPid > 0 && payload["pid"] as? Int == Int(agentPid) &&
      candidate.buildId == installedBuild && candidate.sourceRevision == installedRevision &&
      payload["buildId"] as? String == candidate.buildId && payload["sourceRevision"] as? String == candidate.sourceRevision &&
      payload["attemptId"] as? String == attempt && payload["installationId"] as? String == installation
  }
}
