import Foundation
/** Pure decisions over receipts + the signature-checked installed host identity. */
enum NativeUpdateRecovery {
  enum Decision: String { case unchanged, prepareAgain, deferUnstarted, startTarget, unknown }
  static func decide(state: NativeUpdateState, buildId: String, revision: String, committedWorkload: Bool) -> Decision {
    if state.stage == "preparing" { return .prepareAgain }
    if state.nativeSuccess {
      guard let candidate = state.candidate else { return .unknown }
      return candidate.buildId == buildId && candidate.sourceRevision == revision ? .unchanged : .unknown
    }
    if state.acceptedAt == nil { return .unchanged }
    guard let candidate = state.candidate else { return .unknown }
    if candidate.buildId == buildId && candidate.sourceRevision == revision {
      return committedWorkload ? .startTarget : .unknown
    }
    if state.sourceBuild == buildId && state.sourceRevision == revision && !state.targetStarted &&
      (["consented", "draining", "drained"].contains(state.stage) ||
       // A failure before the handoff (e.g. APP_UPDATE_BUSY while draining) never touched the
       // app; only a reached handoff makes the outcome uncertain (next QA, 2026-11-17).
       (state.stage == "failed" && !state.handoffStarted &&
        ["consented", "draining", "drained"].contains(state.lastProvenStage))) { return .deferUnstarted }
    // After target start, older code/data must never be reactivated automatically.
    return .unknown
  }

  /// A candidate the running copy already is, or has passed — Soty was installed by hand over a
  /// cancelled or failed offer. While nothing of that offer has started, it is forgotten, so the
  /// app stops calling an old version cancelled and a check can answer that it is current
  /// (next QA 2026-11-17: 96 installed by hand still showed «Оновлення скасовано» for 95).
  static func obsolete(state: NativeUpdateState, isNewer: (NativeCandidate) -> Bool) -> Bool {
    guard let candidate = state.candidate, !isNewer(candidate) else { return false }
    guard !state.nativeSuccess, !state.handoffStarted, !state.targetStarted, !state.replacementRequested else { return false }
    return ["idle", "offered", "prepared", "deferred", "cancelled", "failed"].contains(state.stage)
  }
}
