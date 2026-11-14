import { describe, expect, it, vi } from 'vitest';
import {
  releaseNameReservation,
  startOperation,
  transitionOperation
} from '../supabase/functions/_shared/operations';

describe('operation RPC failure classification', () => {
  it.each(['start', 'transition', 'release'] as const)(
    'keeps an unrecognized database failure retryable during %s',
    async action => {
      const service = {
        rpc: vi.fn(async () => ({
          data: null,
          error: { code: '57014', message: 'canceling statement due to statement timeout' }
        }))
      };
      const pending =
        action === 'start'
          ? startOperation({
              service,
              teamId: 'team',
              actorId: 'actor',
              kind: 'copy',
              idempotencyKey: 'operation-key-1234',
              requestNonce: 'operation-nonce-1234'
            })
          : action === 'transition'
            ? transitionOperation({ service, operationId: 'operation', state: 'running' })
            : releaseNameReservation(service, 'operation');
      await expect(pending).rejects.toMatchObject({ code: 'DRIVE_UNAVAILABLE', retryable: true });
      expect(service.rpc).toHaveBeenCalledOnce();
    }
  );

  it.each([
    'PERMISSION_DENIED',
    'NOT_FOUND',
    'INVALID_INPUT',
    'WRONG_STATE',
    'NAME_CONFLICT',
    'SOURCE_CHANGED'
  ])('keeps the known %s refusal final', async code => {
    const service = { rpc: vi.fn(async () => ({ data: null, error: { message: code } })) };
    await expect(releaseNameReservation(service, 'operation')).rejects.toMatchObject({
      code,
      retryable: false
    });
  });
});
