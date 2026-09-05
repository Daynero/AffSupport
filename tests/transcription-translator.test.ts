import { describe, expect, it, vi } from 'vitest';
import {
  LlamaTranslator,
  localLlamaHttpRequest,
  translationNeedsRetry
} from '../apps/agent/src/translation/translator.js';

type Wire = typeof localLlamaHttpRequest;
type Body = { prompt: string; n_predict: number };

/** A translator whose server is "up" on a fake wire; the private seams are driven directly. */
function translatorOn(wire: Wire) {
  const translator = new LlamaTranslator(wire);
  (translator as unknown as { port: number }).port = 4242;
  const run = (text: string) =>
    (
      translator as unknown as {
        runPiece(
          source: string,
          target: string,
          text: string,
          signal: AbortSignal,
          isRetry: boolean
        ): Promise<string>;
      }
    ).runPiece('en', 'uk', text, new AbortController().signal, false);
  return { translator, run };
}

const ok = (content: unknown, extra: Record<string, unknown> = {}) => ({
  statusCode: 200,
  body: JSON.stringify({ content, ...extra })
});

const LONG =
  'Media buying requires careful attention to creative performance, audience targeting and budget allocation across channels. ' +
  'We measure how long the model takes to process one minute of continuous speech on this machine.';

describe('the local translator over a fake wire', () => {
  it('maps the server answers onto messages that never echo the prompt', async () => {
    const rejected = translatorOn(vi.fn(async () => ({ statusCode: 500, body: 'prompt echo' })));
    await expect(rejected.run('Hello.')).rejects.toThrow('rejected the translation request');

    const garbled = translatorOn(vi.fn(async () => ({ statusCode: 200, body: '{not json' })));
    await expect(garbled.run('Hello.')).rejects.toThrow('invalid response');

    const empty = translatorOn(vi.fn(async () => ok('   ')));
    await expect(empty.run('Hello.')).rejects.toThrow('empty translation');

    const fine = translatorOn(vi.fn(async () => ok(' Привіт. ')));
    await expect(fine.run('Hello.')).resolves.toBe('Привіт.');
  });

  it('splits a piece the model could not finish and translates the parts on their own', async () => {
    const calls: Body[] = [];
    const wire: Wire = vi.fn(async (_port, _key, _method, _path, json) => {
      const body = json as Body;
      calls.push(body);
      // The whole piece runs out of tokens; each smaller part comes back clean.
      if (calls.length === 1) return ok('Медіабаїнг вимагає', { stopped_limit: true });
      const source = body.prompt.split('\n').at(-2) ?? '';
      return ok(`[${source.slice(0, 12).trim()}]`);
    });
    const { run } = translatorOn(wire);
    const result = await run(LONG);
    expect(calls.length).toBeGreaterThan(2);
    // The retry pieces are shorter than the original, and the answer is one line again.
    expect(calls.slice(1).every(call => call.n_predict < calls[0].n_predict)).toBe(true);
    expect(result.startsWith('[')).toBe(true);
    expect(result.split('] [').length).toBe(calls.length - 1);
  });

  it('gives up after one bounded retry instead of looping', async () => {
    const wire: Wire = vi.fn(async () => ok('again', { stopped_limit: true }));
    const { run } = translatorOn(wire);
    await expect(run('Hello there.')).rejects.toThrow('incomplete or repetitive');
    // The short text cannot be split, so the retry is the same text once more — and no more.
    expect(wire).toHaveBeenCalledTimes(2);
  });

  it('treats a repeated phrase as a loop only when it dominates the output', () => {
    const phrase = 'the quick brown fox jumps over the lazy dog ';
    expect(translationNeedsRetry(phrase.repeat(6))).toBe(true);
    expect(translationNeedsRetry(`${LONG} ${LONG.replace('Media', 'Video')}`)).toBe(false);
    expect(translationNeedsRetry('short', true)).toBe(true);
    expect(translationNeedsRetry('short')).toBe(false);
  });
});
