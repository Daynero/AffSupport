import { describe, expect, it, vi } from 'vitest';
import type { ClaudeClient, ClaudeRequest } from '../supabase/functions/_shared/claude';
import { translateNotes, type NoteText } from '../supabase/functions/assistant/notes';

// A fake model that «translates» by upper-casing, in the order and count it was given.
function client(fail?: (request: ClaudeRequest) => boolean) {
  const calls: ClaudeRequest[] = [];
  const fake: ClaudeClient = {
    create: vi.fn(async (request: ClaudeRequest) => {
      calls.push(request);
      if (fail?.(request)) return { stopReason: 'max_tokens', text: null, usage: usage() };
      const { notes } = JSON.parse(request.user.split('\n').slice(2).join('\n')) as {
        notes: NoteText[];
      };
      return {
        stopReason: 'end_turn',
        text: JSON.stringify({
          notes: notes.map(note => ({
            title: note.title.toUpperCase(),
            text: note.text.toUpperCase()
          }))
        }),
        usage: usage()
      };
    })
  };
  return { fake, calls };
}
const usage = () => ({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
const options = () => ({ signal: new AbortController().signal, record: vi.fn() });
const notes = (n: number, size = 20): NoteText[] =>
  Array.from({ length: n }, (_, index) => ({
    title: `t${index}`,
    text: `note ${index} `.padEnd(size, 'x')
  }));

describe('launch notes in another language', () => {
  it('translates every note of a long list, in order, never only the first twenty', async () => {
    const { fake, calls } = client();
    const out = await translateNotes(fake, notes(27), 'es-MX', options());
    expect(out).toHaveLength(27);
    expect(out!.map(note => note.title)).toEqual(notes(27).map(note => note.title.toUpperCase()));
    expect(calls).toHaveLength(3);
  });

  it('gives a long note room to come back whole', async () => {
    const { fake, calls } = client();
    await translateNotes(fake, notes(2, 3_000), 'tr', options());
    expect(calls[0]!.maxTokens).toBeGreaterThan(2_000);
  });

  it('carries none when any part failed, instead of half of them', async () => {
    const { fake } = client(request => request.user.includes('t12'));
    expect(await translateNotes(fake, notes(15), 'es', options())).toBeNull();
  });
});
