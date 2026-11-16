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
}
