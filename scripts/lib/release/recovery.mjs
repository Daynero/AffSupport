export function recoverState(run, journalEvents) {
  if (!Array.isArray(journalEvents)) throw new Error('JOURNAL_CORRUPT');
  if (run.state === 'running' || run.state === 'waiting_resource' || run.state === 'waiting_remote') {
    return { ...run, state: 'reconciling', recoveryReason: 'interrupted_worker' };
  }
  return run;
}

export function reconcileEffect(effect, observation) {
  if (observation === 'matching') return { state: 'matching', retry: false };
  if (observation === 'provenAbsent') return { state: 'absent', retry: true };
  return { state: 'blocked', retry: false, code: 'EFFECT_AMBIGUOUS' };
}
