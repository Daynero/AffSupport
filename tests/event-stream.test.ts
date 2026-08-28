import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEventStream, streamUrl, type StreamFrame } from '../apps/web/src/api/event-stream.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function responseFrom(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

describe('the authenticated event-stream reader', () => {
  it('parses fragmented and multiline frames while dropping comments and malformed data', async () => {
    const fetchMock = vi.fn(async () =>
      responseFrom([
        ': heartbeat\n\n',
        'data: {"channel":"compressor",',
        '"event":{"state":"ready"}}\n\n',
        'data: not-json\n\n',
        'data: {"channel":42,"event":"ignored"}\n\n',
        'data: {"channel":"transcription",\n',
        'data: "event":{"done":true}}\n\n'
      ])
    );
    vi.stubGlobal('fetch', fetchMock);
    const frames: StreamFrame[] = [];
    const onOpen = vi.fn();
    const signal = new AbortController().signal;

    await readEventStream({
      url: 'http://127.0.0.1:43120/api/stream',
      token: 'session-token',
      signal,
      onOpen,
      onFrame: frame => frames.push(frame)
    });

    expect(onOpen).toHaveBeenCalledOnce();
    expect(frames).toEqual([
      { channel: 'compressor', event: { state: 'ready' } },
      { channel: 'transcription', event: { done: true } }
    ]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:43120/api/stream', {
      headers: { 'x-session-token': 'session-token', accept: 'text/event-stream' },
      signal,
      cache: 'no-store'
    });
  });

  it.each([
    ['a refused response', new Response('no', { status: 401 }), 401],
    ['a response without a body', new Response(null, { status: 204 }), 204]
  ])('rejects %s', async (_name, response, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );
    await expect(
      readEventStream({
        url: 'http://127.0.0.1:43120/api/stream',
        token: 'session-token',
        signal: new AbortController().signal,
        onFrame: () => {}
      })
    ).rejects.toThrow(`stream refused: ${status}`);
  });
});

describe('the multiplexed stream URL', () => {
  it('contains no query when no channels are requested', () => {
    expect(streamUrl('http://127.0.0.1:43120', [])).toBe('http://127.0.0.1:43120/api/stream');
  });

  it('encodes the requested channel list without adding a token', () => {
    expect(streamUrl('http://127.0.0.1:43120', ['compressor', 'team activity'])).toBe(
      'http://127.0.0.1:43120/api/stream?channels=compressor%2Cteam%20activity'
    );
  });
});
