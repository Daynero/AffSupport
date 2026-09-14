/**
 * What the run has already done, according to the record that survives.
 *
 * The journal is written before each effect and again after it, which is the
 * whole reason it exists -- "an interruption is resumable rather than
 * ambiguous". Recovery took the journal as an argument, validated that it was an
 * array, and then ignored it, reading the completed steps out of the snapshot
 * instead. The snapshot is rewritten by `start`, so every resumed release
 * replayed from the beginning.
 *
 * That is not merely slow. The steps refuse to redo themselves, and rightly: the
 * macOS packager stops on "published build identities are immutable" rather than
 * overwrite an artifact of the same version. So a resumed release walked back to
 * the step it had already finished and was refused by its own guard, on the
 * evidence of its own output.
 *
 * A `step_completed` receipt is the durable claim that the step's effect
 * happened. Believing it is what makes the journal worth writing.
 */
function completedFromJournal(run, journalEvents) {
  const completed = [...(run.completedSteps ?? [])];
  for (const event of journalEvents) {
    const stepId = event?.type === 'step_completed' ? event.payload?.stepId : null;
    if (typeof stepId === 'string' && stepId && !completed.includes(stepId)) completed.push(stepId);
  }
  return completed;
}

export function recoverState(run, journalEvents) {
  if (!Array.isArray(journalEvents)) throw new Error('JOURNAL_CORRUPT');
  const completedSteps = completedFromJournal(run, journalEvents);
  const recovered =
    completedSteps.length > (run.completedSteps?.length ?? 0) ? { ...run, completedSteps } : run;
  if (
    recovered.state === 'running' ||
    recovered.state === 'waiting_resource' ||
    recovered.state === 'waiting_remote'
  ) {
    return { ...recovered, state: 'reconciling', recoveryReason: 'interrupted_worker' };
  }
  return recovered;
}

export function reconcileEffect(effect, observation) {
  if (observation === 'matching') return { state: 'matching', retry: false };
  if (observation === 'provenAbsent') return { state: 'absent', retry: true };
  return { state: 'blocked', retry: false, code: 'EFFECT_AMBIGUOUS' };
}
