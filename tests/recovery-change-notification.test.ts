// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { RECOVERY_CHANGED, retryBackgroundRecovery } from '../apps/web/src/api/recovery';
const calls = vi.hoisted(() => ({ body: vi.fn(), request: vi.fn() }));
vi.mock('../apps/web/src/api/client', () => ({
  requestBody: (...args: unknown[]) => calls.body(...args),
  request: (...args: unknown[]) => calls.request(...args)
}));
vi.mock('../apps/web/src/api/team', () => ({ invokeTeamFunction: vi.fn() }));
vi.mock('../apps/web/src/lib/config', () => ({ publicConfig: { ok: false } }));
afterEach(() => {
  vi.restoreAllMocks();
  calls.body.mockReset();
  calls.request.mockReset();
  localStorage.clear();
});
const status = { enabled: true, installationId: 'synthetic', state: 'ready', reason: null };
it('publishes only an opaque change pulse for other tabs after the mutation succeeds', async () => {
  calls.body.mockResolvedValue({});
  calls.request.mockResolvedValue(status);
  const changed = vi.fn();
  window.addEventListener(RECOVERY_CHANGED, changed);
  try {
    expect(await retryBackgroundRecovery('synthetic-team')).toEqual(status);
    expect(changed).toHaveBeenCalledOnce();
    expect(localStorage.getItem(RECOVERY_CHANGED)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(localStorage.getItem(RECOVERY_CHANGED)).not.toContain('synthetic');
  } finally {
    window.removeEventListener(RECOVERY_CHANGED, changed);
  }
});
it('keeps the same-page notification and authoritative read when storage is unavailable', async () => {
  calls.body.mockResolvedValue({});
  calls.request.mockResolvedValue(status);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  const changed = vi.fn();
  window.addEventListener(RECOVERY_CHANGED, changed);
  try {
    expect(await retryBackgroundRecovery('synthetic-team')).toEqual(status);
    expect(changed).toHaveBeenCalledOnce();
    expect(calls.request).toHaveBeenCalledWith('/api/team/recovery/synthetic-team');
  } finally {
    window.removeEventListener(RECOVERY_CHANGED, changed);
  }
});
it('does not announce a change when the mutation failed', async () => {
  calls.body.mockRejectedValue(new Error('unavailable'));
  const changed = vi.fn();
  window.addEventListener(RECOVERY_CHANGED, changed);
  try {
    await expect(retryBackgroundRecovery('synthetic-team')).rejects.toThrow('unavailable');
    expect(changed).not.toHaveBeenCalled();
    expect(localStorage.getItem(RECOVERY_CHANGED)).toBeNull();
    expect(calls.request).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(RECOVERY_CHANGED, changed);
  }
});
