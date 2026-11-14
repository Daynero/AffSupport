import { describe, expect, it, vi } from 'vitest';
import { parseJsonBody } from '../supabase/functions/_shared/validation';

function streamedRequest(chunks: Uint8Array[], headers: HeadersInit = {}) {
  let index = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(chunks[index++]!);
    else controller.close();
  });
  const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, headers, duplex: 'half' };
  return { request: new Request('https://edge.example.test', init), pull, cancel };
}

describe('Edge JSON request byte limit', () => {
  it.each([new Headers(), new Headers({ 'content-length': '1' })])(
    'stops reading an oversized stream even with length headers %o',
    async headers => {
      const { request, pull, cancel } = streamedRequest(
        [new Uint8Array(8), new Uint8Array(1), new Uint8Array(100)],
        headers
      );
      expect(await parseJsonBody(request, 8)).toEqual({ ok: false, error: 'INVALID_INPUT' });
      expect(pull).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      expect(request.body?.locked).toBe(false);
    }
  );

  it('rejects a declared overflow without reading and cancels the body', async () => {
    const { request, pull, cancel } = streamedRequest([new Uint8Array(100)], {
      'content-length': '100'
    });
    expect(await parseJsonBody(request, 8)).toEqual({ ok: false, error: 'INVALID_INPUT' });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not wait for the sender to acknowledge cancellation', async () => {
    const { request, cancel } = streamedRequest([new Uint8Array(9), new Uint8Array(100)]);
    cancel.mockImplementation(() => new Promise<void>(() => {}));
    expect(await parseJsonBody(request, 8)).toEqual({ ok: false, error: 'INVALID_INPUT' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('counts UTF-8 bytes while accepting characters split across chunks at the limit', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: 'Привіт 🐝' }));
    const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
    expect(await parseJsonBody(streamedRequest(chunks).request, bytes.length)).toEqual({
      ok: true,
      value: { text: 'Привіт 🐝' }
    });
    expect(await parseJsonBody(streamedRequest(chunks).request, bytes.length - 1)).toEqual({
      ok: false,
      error: 'INVALID_INPUT'
    });
  });

  it.each(['', 'null', '[]', '42', '{broken'])('rejects non-object JSON %j', async body => {
    expect(
      await parseJsonBody(new Request('https://edge.example.test', { method: 'POST', body }))
    ).toEqual({ ok: false, error: 'INVALID_INPUT' });
  });
});
