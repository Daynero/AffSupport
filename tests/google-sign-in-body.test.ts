import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let handler: (request: Request) => Response | Promise<Response>;
const fetcher = vi.fn();
beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (key: string) => (key === 'WISHLY_SITE_URL' ? 'https://soty.pp.ua' : undefined) },
    serve: (serve: typeof handler) => {
      handler = serve;
    }
  });
  vi.stubGlobal('fetch', fetcher);
  await import('../supabase/functions/google-sign-in/index');
});
afterAll(() => vi.unstubAllGlobals());

describe('public Google sign-in body admission', () => {
  it('rejects an oversized chunked request before any provider call', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(65_537));
        },
        cancel
      },
      { highWaterMark: 0 }
    );
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { origin: 'https://soty.pp.ua' }
    };
    const answer = await handler(new Request('https://edge.example.test/google-sign-in', init));
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves the configured fallback for a valid sign-in request', async () => {
    const answer = await handler(
      new Request('https://edge.example.test/google-sign-in', {
        method: 'POST',
        headers: { origin: 'https://soty.pp.ua' },
        body: JSON.stringify({
          action: 'start',
          codeChallenge: 'a'.repeat(43),
          nonceHash: 'a'.repeat(64),
          state: 'a'.repeat(22)
        })
      })
    );
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      ok: true,
      value: { mode: 'legacy', reason: 'not_configured' }
    });
  });
});
