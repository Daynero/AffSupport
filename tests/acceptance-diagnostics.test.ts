import { describe, expect, it, vi } from 'vitest';
import {
  acceptanceActorAllowed,
  acceptanceCaptureAllowed,
  AcceptanceCaptureQueue
} from '../apps/web/src/analytics/acceptance-capture';
const config = {
  development: true,
  environment: 'beta',
  origin: 'http://127.0.0.1:5175',
  supabaseUrl: 'http://127.0.0.1:54321',
  campaignId: 'acceptance-test-001'
};
describe('independent local acceptance capture', () => {
  it('requires local development beta and an explicit synthetic campaign', () => {
    expect(acceptanceCaptureAllowed(config)).toBe(true);
    for (const patch of [
      { development: false },
      { environment: 'production' },
      { origin: 'https://soty.pp.ua' },
      { supabaseUrl: 'https://remote.supabase.co' },
      { campaignId: '' }
    ])
      expect(acceptanceCaptureAllowed({ ...config, ...patch })).toBe(false);
  });
  it('bounds queues and reports absent delivery rather than fabricating it', async () => {
    const sender = vi.fn().mockResolvedValue(false);
    const capture = new AcceptanceCaptureQueue(sender);
    for (let i = 0; i < 80; i++) capture.enqueue({ event_id: `event-${i}` });
    expect(capture.status()).toMatchObject({ queued: 60, dropped: 20, accepted: 0 });
    await capture.flush();
    await capture.flush();
    await capture.flush();
    expect(capture.status().dropped).toBeGreaterThan(20);
    expect(capture.status().accepted).toBe(0);
    capture.stop();
  });
  it('only acknowledges evidence after ingestion accepts it', async () => {
    const capture = new AcceptanceCaptureQueue(vi.fn().mockResolvedValue(true));
    capture.enqueue({ event_id: 'synthetic' });
    await capture.flush();
    expect(capture.status()).toMatchObject({ queued: 0, accepted: 1 });
    capture.stop();
  });
  it('keeps in-flight evidence inside the total queue budget without double accounting', async () => {
    let finish: ((value: boolean) => void) | undefined;
    const sender = () =>
      new Promise<boolean>(resolve => {
        finish = resolve;
      });
    const capture = new AcceptanceCaptureQueue(sender);
    for (let i = 0; i < 20; i++) capture.enqueue({ event_id: `initial-${i}` });
    const pending = capture.flush();
    for (let i = 0; i < 80; i++) capture.enqueue({ event_id: `later-${i}` });
    expect(capture.status()).toMatchObject({ queued: 60, dropped: 40, deliveryKnown: false });
    finish?.(true);
    await pending;
    expect(capture.status()).toMatchObject({ queued: 40, accepted: 20, dropped: 40 });
    capture.stop();
  });
  it('retains only missing events after a partial ingestion receipt', async () => {
    const sender = vi
      .fn()
      .mockResolvedValueOnce(new Set(['one']))
      .mockResolvedValueOnce(new Set(['two']));
    const capture = new AcceptanceCaptureQueue(sender);
    capture.enqueue({ event_id: 'one' });
    capture.enqueue({ event_id: 'two' });
    await capture.flush();
    expect(capture.status()).toMatchObject({ accepted: 1, queued: 1, dropped: 0 });
    await capture.flush();
    expect(capture.status()).toMatchObject({ accepted: 2, queued: 0, dropped: 0 });
    capture.stop();
  });
  it('aborts a stalled ingestion request and keeps its outcome unknown', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const capture = new AcceptanceCaptureQueue(
      (_events, signal) =>
        new Promise<boolean>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        })
    );
    try {
      capture.enqueue({ event_id: 'stalled' });
      const pending = capture.flush();
      await vi.advanceTimersByTimeAsync(10001);
      await pending;
      expect(aborted).toBe(true);
      expect(capture.status()).toMatchObject({ accepted: 0, queued: 1, deliveryKnown: false });
    } finally {
      capture.stop();
      vi.useRealTimers();
    }
  });
  it('does not admit another actor or a non-campaign account', () => {
    expect(
      acceptanceActorAllowed(
        { id: 'actor-a', user_metadata: { acceptance_namespace: 'acceptance-test-001' } },
        'actor-a',
        'acceptance-test-001'
      )
    ).toBe(true);
    expect(
      acceptanceActorAllowed(
        { id: 'actor-b', user_metadata: { acceptance_namespace: 'acceptance-test-001' } },
        'actor-a',
        'acceptance-test-001'
      )
    ).toBe(false);
    expect(
      acceptanceActorAllowed({ id: 'actor-a', user_metadata: {} }, 'actor-a', 'acceptance-test-001')
    ).toBe(false);
    expect(acceptanceActorAllowed(null, 'actor-a', 'acceptance-test-001')).toBe(false);
  });
});
