export function budgetReason(budget, cause, policy, now = Date.now()) {
  const attempts = budget.attempts ?? [];
  if (attempts.length >= policy.maxAttemptsPerTask) return 'REPAIR_TASK_BUDGET_EXHAUSTED';
  if (attempts.filter((a) => a.cause === cause).length >= policy.maxAttemptsPerCause) return 'REPAIR_CAUSE_BUDGET_EXHAUSTED';
  if (budget.totalTokens >= policy.maxTokensPerTask || attempts.some((a) => a.overshootTokens > 0)) return 'REPAIR_TOKEN_BUDGET_EXHAUSTED';
  if (attempts.reduce((sum, a) => sum + (a.activeMs ?? (now - a.startedAt)), 0) >= policy.maxActiveMsPerTask) return 'REPAIR_TIME_BUDGET_EXHAUSTED';
  if (attempts.some((a) => a.finished && a.usage?.totalTokens == null)) return 'REPAIR_USAGE_UNKNOWN';
  return null;
}
export function reserveAttempt(budget, cause, policy, executionId, now = Date.now()) {
  const reason = budgetReason(budget, cause, policy, now);
  if (reason) throw new Error(reason);
  if ((budget.attempts ?? []).some((a) => a.executionId === executionId)) return budget;
  return { ...budget, attempts: [...(budget.attempts ?? []), { executionId, cause, startedAt: now, activeMs: null, usage: null, finished: false, overshootTokens: 0 }] };
}
export function recordUsage(budget, executionId, usage, now = Date.now(), cap = 80000) {
  const attempts = budget.attempts.map((a) => a.executionId !== executionId ? a : {
    ...a, usage: usage.totalTokens >= (a.usage?.totalTokens ?? 0) ? usage : a.usage,
    activeMs: now - a.startedAt, overshootTokens: Math.max(0, (usage.totalTokens ?? 0) - cap),
  });
  const known = attempts.filter((a) => a.usage?.totalTokens != null);
  return { ...budget, attempts, totalTokens: known.length ? known.reduce((sum, a) => sum + a.usage.totalTokens, 0) : null };
}
