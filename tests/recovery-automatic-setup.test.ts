// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureBackgroundRecovery } from '../apps/web/src/api/recovery';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const INSTALL = '22222222-2222-4222-8222-222222222222';
const state = vi.hoisted(() => ({
  request: vi.fn(),
  body: vi.fn(),
  cloud: vi.fn(),
  session: vi.fn(),
  revision: 1
}));
vi.mock('../apps/web/src/api/client', () => ({
  request: (...a: unknown[]) => state.request(...a),
  requestBody: (...a: unknown[]) => state.body(...a)
}));
vi.mock('../apps/web/src/api/team', () => ({
  invokeTeamFunction: (...a: unknown[]) => state.cloud(...a)
}));
vi.mock('../apps/web/src/api/entitlement', () => ({
  ensureAgentEntitlement: vi.fn(async () => {})
}));
vi.mock('../apps/web/src/api/entitlement-retirement', () => ({
  agentIdentityRevision: () => state.revision
}));
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: { ok: true, value: { supabaseUrl: 'https://synthetic.test' } }
}));
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ auth: { getSession: () => state.session() } })
}));
vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: { track: vi.fn(), journalContext: () => ({ userId: null }) }
}));
const ready = {
  enabled: true,
  installationId: INSTALL,
  automaticSetup: 'ready',
  state: 'idle',
  reason: null
};
beforeEach(() => {
  state.revision = 1;
  state.session.mockResolvedValue({ data: { session: { user: { id: ACTOR } } }, error: null });
  state.request
    .mockResolvedValueOnce({ ...ready, enabled: false, automaticSetup: 'eligible' })
    .mockResolvedValue(ready);
  state.body
    .mockResolvedValueOnce({
      enrollmentId: INSTALL,
      installationId: INSTALL,
      ticketDigest: 'a'.repeat(64)
    })
    .mockResolvedValue({ enabled: true });
  state.cloud.mockResolvedValue({ challengeId: INSTALL });
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
});
it('enrolls the current actor with an authoritative cloud fence and only opaque notifications', async () => {
  const observe = vi.fn();
  await expect(
    ensureBackgroundRecovery(INSTALL, {
      actorId: ACTOR,
      isCurrent: () => true,
      onSetupStage: observe
    })
  ).resolves.toEqual(ready);
  expect(state.cloud).toHaveBeenCalledWith(
    'team-recovery',
    expect.objectContaining({ expectedActorId: ACTOR, automatic: true }),
    expect.any(Function),
    expect.any(Object)
  );
  expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'ready', outcome: 'succeeded' });
  expect(localStorage.getItem('soty.recovery.changed')).toMatch(/^[a-f0-9-]{36}$/u);
});
it('rejects an identity change after delegation before native confirmation', async () => {
  state.cloud.mockImplementation(async () => {
    state.revision += 1;
    return { challengeId: INSTALL };
  });
  await expect(
    ensureBackgroundRecovery(INSTALL, { actorId: ACTOR, isCurrent: () => true })
  ).rejects.toThrow('ENTITLEMENT_SIGNIN_REQUIRED');
  expect(state.body).toHaveBeenCalledOnce();
});
it('bounds stalled auth acquisition without starting native setup', async () => {
  vi.useFakeTimers();
  state.session.mockImplementation(() => new Promise(() => {}));
  const operation = ensureBackgroundRecovery(INSTALL, { actorId: ACTOR, isCurrent: () => true });
  const failed = expect(operation).rejects.toThrow('WORKSPACE_READ_TIMEOUT');
  await vi.advanceTimersByTimeAsync(10_000);
  await failed;
  expect(state.body).not.toHaveBeenCalled();
});
it('does not re-enroll a revoked or retiring owner', async () => {
  state.request
    .mockReset()
    .mockResolvedValue({ ...ready, enabled: false, automaticSetup: 'retiring' });
  await expect(
    ensureBackgroundRecovery(INSTALL, { actorId: ACTOR, isCurrent: () => true })
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(state.body).not.toHaveBeenCalled();
});
it.each(['checkpoint_unavailable', 'retry_exhausted'])(
  'resumes %s when the user explicitly submits new work',
  async reason => {
    state.request
      .mockReset()
      .mockResolvedValueOnce({ ...ready, state: 'blocked', reason })
      .mockResolvedValue(ready);
    state.body.mockReset().mockResolvedValue({ retrying: true });
    await ensureBackgroundRecovery(INSTALL, {
      actorId: ACTOR,
      isCurrent: () => true,
      resumeBlockedWork: true
    });
    expect(state.body).toHaveBeenCalledOnce();
    expect(state.body).toHaveBeenCalledWith(
      '/api/team/recovery/retry',
      { teamId: INSTALL },
      'POST',
      expect.any(AbortSignal)
    );
    expect(state.cloud).not.toHaveBeenCalled();
  }
);
it('does not waive the recovery budget during a passive ownership read', async () => {
  state.request
    .mockReset()
    .mockResolvedValue({ ...ready, state: 'blocked', reason: 'retry_exhausted' });
  await ensureBackgroundRecovery(INSTALL, { actorId: ACTOR, isCurrent: () => true });
  expect(state.body).not.toHaveBeenCalled();
});
it.each(['running', 'settled'])(
  'adopts a retry already %s in another tab after a stale blocked status',
  async stateAfterRetry => {
    state.request
      .mockReset()
      .mockResolvedValueOnce({ ...ready, state: 'blocked', reason: 'retry_exhausted' })
      .mockResolvedValue({ ...ready, state: stateAfterRetry });
    state.body.mockReset().mockRejectedValue(new Error('WRONG_STATE'));
    await expect(
      ensureBackgroundRecovery(INSTALL, {
        actorId: ACTOR,
        isCurrent: () => true,
        resumeBlockedWork: true
      })
    ).resolves.toMatchObject({ enabled: true, state: stateAfterRetry });
    expect(state.body).toHaveBeenCalledOnce();
    expect(state.cloud).not.toHaveBeenCalled();
  }
);
it('does not conceal a retry refusal when the authoritative state remains blocked', async () => {
  state.request
    .mockReset()
    .mockResolvedValue({ ...ready, state: 'blocked', reason: 'retry_exhausted' });
  state.body.mockReset().mockRejectedValue(new Error('WRONG_STATE'));
  await expect(
    ensureBackgroundRecovery(INSTALL, {
      actorId: ACTOR,
      isCurrent: () => true,
      resumeBlockedWork: true
    })
  ).rejects.toThrow('WRONG_STATE');
  expect(localStorage.getItem('soty.recovery.changed')).toBeNull();
});
// Production 2026-11-24: a computer that finds its handle lost while resuming asks to be set up
// again; the page sets it up at once instead of reporting «no permission» until the next focus.
it('sets background work up again when resuming finds the stored handle lost', async () => {
  state.request
    .mockReset()
    .mockResolvedValueOnce({ ...ready, state: 'blocked', reason: 'retry_exhausted' })
    .mockResolvedValueOnce({
      ...ready,
      enabled: true,
      automaticSetup: 'eligible',
      state: 'blocked',
      reason: 'needs_agent_setup'
    })
    .mockResolvedValue(ready);
  state.body
    .mockReset()
    .mockRejectedValueOnce(new Error('WRONG_STATE'))
    .mockResolvedValueOnce({
      enrollmentId: INSTALL,
      installationId: INSTALL,
      ticketDigest: 'a'.repeat(64),
      renewalDelegationId: ACTOR
    })
    .mockResolvedValue({ enabled: true });
  await expect(
    ensureBackgroundRecovery(INSTALL, {
      actorId: ACTOR,
      isCurrent: () => true,
      resumeBlockedWork: true
    })
  ).resolves.toEqual(ready);
  expect(state.cloud).toHaveBeenCalledWith(
    'team-recovery',
    expect.objectContaining({ action: 'delegate', renewalDelegationId: ACTOR }),
    expect.any(Function),
    expect.any(Object)
  );
});
it('does not resume background work after the actor changes during the status read', async () => {
  state.request.mockReset().mockImplementation(async () => {
    state.revision++;
    return { ...ready, state: 'blocked', reason: 'retry_exhausted' };
  });
  await expect(
    ensureBackgroundRecovery(INSTALL, {
      actorId: ACTOR,
      isCurrent: () => true,
      resumeBlockedWork: true
    })
  ).rejects.toThrow('ENTITLEMENT_SIGNIN_REQUIRED');
  expect(state.body).not.toHaveBeenCalled();
});

it('does not report resumed work when ownership is revoked during native retry', async () => {
  state.request
    .mockReset()
    .mockResolvedValueOnce({ ...ready, state: 'blocked', reason: 'retry_exhausted' })
    .mockResolvedValue({ ...ready, enabled: false, automaticSetup: 'retiring' });
  state.body.mockReset().mockResolvedValue({ retrying: true });
  const observe = vi.fn();
  await expect(
    ensureBackgroundRecovery(INSTALL, {
      actorId: ACTOR,
      isCurrent: () => true,
      resumeBlockedWork: true,
      onSetupStage: observe
    })
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: 'failed' });
  expect(localStorage.getItem('soty.recovery.changed')).toBeNull();
});
it('bounds an unresponsive native retry without creating a replacement delegation', async () => {
  vi.useFakeTimers();
  state.request
    .mockReset()
    .mockResolvedValue({ ...ready, state: 'blocked', reason: 'checkpoint_unavailable' });
  state.body.mockReset().mockImplementation(() => new Promise(() => {}));
  const operation = ensureBackgroundRecovery(INSTALL, {
    actorId: ACTOR,
    isCurrent: () => true,
    resumeBlockedWork: true
  });
  const failed = expect(operation).rejects.toThrow('WORKSPACE_READ_TIMEOUT');
  await vi.advanceTimersByTimeAsync(10_000);
  await failed;
  expect(state.cloud).not.toHaveBeenCalled();
  expect(state.body).toHaveBeenCalledOnce();
});
